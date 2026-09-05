import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MODEL_PREVIEW_BYTES_PER_STREAM = 8 * 1024
const LIVE_CHUNK_BYTES = 8 * 1024
const MAX_LIVE_OUTPUT_BYTES = 256 * 1024

export type ExecOutputChunk = {
    stream: "stdout" | "stderr"
    offset: number
    text: string
}

export type ExecInput = {
    command: string
    cwd: string
    callId?: string
    outputDirectory?: string
    timeoutMs?: number
    signal?: AbortSignal
    backgroundSignal?: AbortSignal
    onOutput?: (chunk: ExecOutputChunk) => void | Promise<void>
}

export type ExecResult = {
    exitCode: number | null
    stdout: string
    stderr: string
    stdoutBytes: number
    stderrBytes: number
    outputPath: string
    outputSha256: string | null
    timedOut: boolean
    durationMs: number
    truncated: boolean
    liveOutputTruncated: boolean
    backgrounded?: boolean
    pid?: number
    statusPath?: string
    joinCommand?: string
}

const takeUtf8Prefix = (value: string, maximumBytes: number): string => {
    if (maximumBytes <= 0 || !value) {
        return ""
    }
    let result = ""
    let bytes = 0
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character)
        if (bytes + characterBytes > maximumBytes) {
            break
        }
        result += character
        bytes += characterBytes
    }
    return result
}

const resultDirectoryName = (callId: string): string => {
    const safe = callId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
    return safe && safe !== "." && safe !== ".." ? safe : randomUUID()
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`

export const runExec = async (input: ExecInput): Promise<ExecResult> => {
    input.signal?.throwIfAborted()
    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS)
    const startedAt = performance.now()
    const resultDirectory = join(input.outputDirectory ?? join(input.cwd, ".puppygpt", "exec-results"), resultDirectoryName(input.callId ?? randomUUID()))
    const outputPath = join(resultDirectory, "output.log")
    const statusPath = join(resultDirectory, "status.json")
    await mkdir(resultDirectory, { recursive: true, mode: 0o700 })
    const outputFile = await open(outputPath, "w", 0o600)
    const outputHash = createHash("sha256")
    let outputWrite = Promise.resolve()
    let liveOutputWrite = Promise.resolve()
    let liveOutputBytes = 0
    let liveOutputTruncated = false
    const previews = { stdout: "", stderr: "" }
    const outputBytes = { stdout: 0, stderr: 0 }
    let subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">
    try {
        input.signal?.throwIfAborted()
        subprocess = Bun.spawn({
            cmd: ["bash", "-c", input.command],
            cwd: input.cwd,
            detached: true,
            env: process.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        })
    } catch (error) {
        await outputFile.close()
        throw error
    }
    let timedOut = false
    let aborted = false
    const kill = () => {
        try {
            process.kill(-subprocess.pid, "SIGKILL")
        } catch {
            try {
                subprocess.kill("SIGKILL")
            } catch {
                // The process group finished between cancellation and the kill.
            }
        }
    }
    const abort = () => {
        aborted = true
        kill()
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    if (input.signal?.aborted) {
        abort()
    }
    const timer = setTimeout(() => {
        timedOut = true
        kill()
    }, timeoutMs)

    const consume = async (stream: ReadableStream<Uint8Array> | null, streamName: "stdout" | "stderr") => {
        if (!stream) {
            return
        }
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        let emittedOffset = 0
        const handleText = async (text: string) => {
            const previewRemaining = MODEL_PREVIEW_BYTES_PER_STREAM - Buffer.byteLength(previews[streamName])
            previews[streamName] += takeUtf8Prefix(text, previewRemaining)
            if (!input.onOutput || !text) {
                return
            }
            liveOutputWrite = liveOutputWrite.then(async () => {
                let remaining = text
                while (remaining && liveOutputBytes < MAX_LIVE_OUTPUT_BYTES) {
                    const allowed = Math.min(LIVE_CHUNK_BYTES, MAX_LIVE_OUTPUT_BYTES - liveOutputBytes)
                    const chunk = takeUtf8Prefix(remaining, allowed)
                    if (!chunk) {
                        break
                    }
                    const chunkBytes = Buffer.byteLength(chunk)
                    liveOutputBytes += chunkBytes
                    await input.onOutput?.({ stream: streamName, offset: emittedOffset, text: chunk })
                    emittedOffset += chunkBytes
                    remaining = remaining.slice(chunk.length)
                }
                if (remaining) {
                    liveOutputTruncated = true
                }
            })
            await liveOutputWrite
        }
        while (true) {
            const chunk = await reader.read()
            if (chunk.done) {
                await handleText(decoder.decode())
                break
            }
            const bytes = Buffer.from(chunk.value)
            outputBytes[streamName] += bytes.byteLength
            outputWrite = outputWrite.then(async () => {
                outputHash.update(bytes)
                await outputFile.write(bytes)
            })
            await Promise.all([outputWrite, handleText(decoder.decode(bytes, { stream: true }))])
        }
    }

    const completion = (async (): Promise<ExecResult> => {
        let exitCode: number
        try {
            [exitCode] = await Promise.all([
                subprocess.exited,
                consume(subprocess.stdout, "stdout"),
                consume(subprocess.stderr, "stderr"),
            ])
            await outputWrite
            await liveOutputWrite
        } finally {
            clearTimeout(timer)
            input.signal?.removeEventListener("abort", abort)
            await outputFile.close()
        }
        if (aborted) {
            throw new DOMException("Agent turn was cancelled", "AbortError")
        }
        const result: ExecResult = {
            exitCode,
            stdout: previews.stdout,
            stderr: previews.stderr,
            stdoutBytes: outputBytes.stdout,
            stderrBytes: outputBytes.stderr,
            outputPath,
            outputSha256: outputHash.digest("hex"),
            timedOut,
            durationMs: Math.round(performance.now() - startedAt),
            truncated: outputBytes.stdout > Buffer.byteLength(previews.stdout) || outputBytes.stderr > Buffer.byteLength(previews.stderr),
            liveOutputTruncated,
        }
        const temporaryStatusPath = `${statusPath}.tmp`
        await writeFile(temporaryStatusPath, `${JSON.stringify({
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            outputPath: result.outputPath,
            outputSha256: result.outputSha256,
        }, null, 2)}\n`, { mode: 0o600 })
        await rename(temporaryStatusPath, statusPath)
        return result
    })()

    if (!input.backgroundSignal) {
        return completion
    }
    const backgrounded = new Promise<"backgrounded">(resolve => {
        if (input.backgroundSignal?.aborted) {
            resolve("backgrounded")
            return
        }
        input.backgroundSignal?.addEventListener("abort", () => resolve("backgrounded"), { once: true })
    })
    if (await Promise.race([completion.then(() => "completed" as const), backgrounded]) === "completed") {
        return completion
    }
    input.signal?.removeEventListener("abort", abort)
    void completion.catch(error => {
        console.error(`Background command ${subprocess.pid} failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return {
        exitCode: null,
        stdout: previews.stdout,
        stderr: previews.stderr,
        stdoutBytes: outputBytes.stdout,
        stderrBytes: outputBytes.stderr,
        outputPath,
        outputSha256: null,
        timedOut: false,
        durationMs: Math.round(performance.now() - startedAt),
        truncated: false,
        liveOutputTruncated,
        backgrounded: true,
        pid: subprocess.pid,
        statusPath,
        joinCommand: `while [ ! -f ${shellQuote(statusPath)} ]; do sleep 1; done; cat ${shellQuote(statusPath)}; cat ${shellQuote(outputPath)}`,
    }
}
