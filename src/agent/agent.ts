import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getFreshAuth, type AgentAuth, type AuthStorage } from "./auth"
import { runExec, type ExecInput, type ExecOutputChunk, type ExecResult } from "./exec"
import { viewImage, type ViewedImage } from "./image"
import { generateImage, IMAGEGEN_TOOL, parseImagegenArgs, type ImagegenArgs } from "./imagegen"
import { extractOutputText, HttpError, RetryableResponseError, RetryableTransportError, streamCodexResponse } from "./responses"
import { asNumber, asObject, asString, type FetchLike, type JsonObject } from "./types"

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const DEFAULT_MODEL = "gpt-5.6-sol"
const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
    "gpt-6-astra": 1_050_000,
    "gpt-5.6-sol": 272_000,
    "gpt-5.6-terra": 272_000,
    "gpt-5.6-luna": 272_000,
}
const AUTO_COMPACT_PERCENT = 0.9
const DEFAULT_CODEX_CLIENT_VERSION = "0.147.0"
const RETAINED_USER_MESSAGE_CHARS = 64_000 * 4
const TOOL_ONLY_COMPLETION_TEXT = "Done."
const MAX_REQUEST_RETRIES = 360
const RETRY_BASE_DELAY_MS = 1_000
const RETRY_MAX_DELAY_MS = 60_000
const coreInstructions = (cwd: string): string => `Your name is PuppyGPT, a general-purpose assistant that can carry out tasks using tools.
Your working directory is ${cwd}.
The root ${cwd}/AGENTS.md content is included below when the file exists. Find and read every other AGENTS.md that applies to the files you inspect or change. Each AGENTS.md governs its directory and descendants; deeper instructions take precedence.
Follow the user's request, verify your work, and report results accurately.`

const EXEC_TOOL: JsonObject = {
    type: "function",
    name: "exec",
    description: "Run a Bash command in the agent working directory and return its exit code, stdout, and stderr. If new user guidance arrives while the command is running, it is automatically moved to the background and the result includes a Bash command that can be used to wait for it.",
    strict: true,
    parameters: {
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The Bash command to run.",
            },
            timeout_ms: {
                type: ["integer", "null"],
                minimum: 100,
                maximum: 600000,
                description: "Optional command timeout in milliseconds.",
            },
        },
        required: ["command", "timeout_ms"],
        additionalProperties: false,
    },
}

const viewImageTool = (cwd: string): JsonObject => ({
    type: "function",
    name: "view_image",
    description: `View a local image file inside ${cwd} and return it as visual input.`,
    strict: true,
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: `Absolute or ${cwd}-relative path to a PNG, JPEG, GIF, or WebP image.`,
            },
        },
        required: ["path"],
        additionalProperties: false,
    },
})

const WEB_SEARCH_TOOL: JsonObject = { type: "web_search" }
const RESPONSE_INCLUDES = ["reasoning.encrypted_content", "web_search_call.action.sources"]

export type RunAgentOptions = {
    cwd?: string
    instructions?: string
    maxRetries?: number
    prompt: string
    model?: string
    reasoningEffort?: string
    fastMode?: boolean
    authFile?: string
    authStorage?: AuthStorage
    endpoint?: string
    issuer?: string
    maxSteps?: number
    contextWindow?: number
    fetchImpl?: FetchLike
    execute?: (input: ExecInput) => Promise<ExecResult>
    inspectImage?: (path: string, workdir?: string) => Promise<ViewedImage>
    onToolCall?: (command: string) => void
    onInteraction?: (interaction: AgentInteraction) => void | Promise<void>
    loadWorkspaceInstructions?: () => Promise<string>
}

export type AgentTurnOptions = Omit<RunAgentOptions, "prompt">

export type AgentInteraction =
    | { type: "text_delta", step: number, text: string }
    | { type: "request", step: number, body: JsonObject }
    | { type: "response", step: number, response: { id?: string, output: JsonObject[], usage?: JsonObject } }
    | { type: "compaction_start", compactionId: string, reason: "auto" | "context_overflow", contextTokens?: number }
    | { type: "compaction_complete", compactionId: string, reason: "auto" | "context_overflow", contextTokens?: number, retainedUserMessages: number }
    | { type: "compaction_error", compactionId: string, reason: "auto" | "context_overflow", contextTokens?: number, error: string }
    | { type: "tool_start", step: number, callId: string, command: string }
    | { type: "tool_output", step: number, callId: string, chunk: ExecOutputChunk }
    | { type: "tool_result", step: number, callId: string, command: string, result: ExecResult }
    | { type: "tool_error", step: number, callId: string, error: string }
    | { type: "image_start", step: number, callId: string, path: string }
    | { type: "image_result", step: number, callId: string, path: string, mimeType: string, size: number }
    | { type: "imagegen_start", step: number, callId: string, prompt: string }
    | { type: "imagegen_result", step: number, callId: string, path: string, prompt: string }
    | { type: "web_search", step: number, callId: string, status: "in_progress" | "searching" | "completed" }
    | { type: "final", step: number, text: string }

const requestHeaders = (auth: AgentAuth, sessionId: string): Headers => {
    const headers = new Headers({
        Accept: "text/event-stream",
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "puppygpt",
        originator: "puppygpt",
        "session-id": sessionId,
    })
    if (auth.accountId) {
        headers.set("ChatGPT-Account-ID", auth.accountId)
    }
    return headers
}

const endpointFor = (endpoint: string, path: string): string => {
    const url = new URL(endpoint)
    if (!url.pathname.endsWith("/responses")) {
        throw new Error(`Codex endpoint must end with /responses: ${endpoint}`)
    }
    url.pathname = `${url.pathname.slice(0, -"responses".length)}${path}`
    url.search = ""
    return url.toString()
}

const contextOverflow = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    return message.includes("context window")
        || message.includes("context length")
        || message.includes("maximum context")
        || message.includes("too many tokens")
        || message.includes("prompt is too long")
}

const retryableRequestError = (error: unknown): boolean => {
    if (error instanceof RetryableTransportError) {
        return true
    }
    if (error instanceof RetryableResponseError) {
        return !contextOverflow(error)
    }
    if (error instanceof HttpError && [429, 500, 502, 503, 504].includes(error.status)) {
        return true
    }
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    return message.includes("server is overloaded")
        || message.includes("server overloaded")
        || message.includes("server is busy")
        || message.includes("service unavailable")
        || message.includes("temporarily unavailable")
        || message.includes("too many requests")
        || message.includes("rate limit")
        || message.includes("try again later")
}

const waitForRetry = async (delayMs: number, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    if (delayMs <= 0) {
        return
    }
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timeout)
            reject(signal.reason)
        }
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort)
            resolve()
        }, delayMs)
        signal.addEventListener("abort", onAbort, { once: true })
    })
}

type ParsedFunctionCall =
    | { callId: string, name: "exec", command: string, timeoutMs?: number }
    | { callId: string, name: "view_image", path: string }
    | { callId: string, name: "imagegen", args: ImagegenArgs }

const parseFunctionCall = (item: JsonObject): ParsedFunctionCall => {
    const callId = asString(item.call_id)
    const name = asString(item.name)
    if (!callId || (name !== "exec" && name !== "view_image" && name !== "imagegen")) {
        throw new Error(`Unsupported tool call: ${name ?? "unknown"}`)
    }
    const argumentsJson = asString(item.arguments)
    const parsed = argumentsJson ? asObject(JSON.parse(argumentsJson)) : undefined
    if (name === "imagegen") return { callId, name, args: parseImagegenArgs(parsed) }
    if (name === "view_image") {
        const path = asString(parsed?.path)?.trim()
        if (!path) {
            throw new Error("view_image requires a non-empty path")
        }
        return { callId, name, path }
    }
    const command = asString(parsed?.command)
    if (!command) {
        throw new Error("exec requires a non-empty command")
    }
    return { callId, name, command, timeoutMs: asNumber(parsed?.timeout_ms) }
}

const toolError = (error: unknown): string => `Tool could not be executed: ${error instanceof Error ? error.message : String(error)}`

export const formatExecResult = (result: ExecResult): string => {
    const status = result.backgrounded
        ? `Command is still running in the background as PID ${result.pid}. New user guidance arrived after ${(result.durationMs / 1000).toFixed(1)}s.`
        : result.timedOut
            ? `Command timed out after ${(result.durationMs / 1000).toFixed(1)}s with exit code ${result.exitCode}.`
            : `Command finished with exit code ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s.`
    const lines = [status]
    if (result.stdout) {
        lines.push("", "Stdout preview:", result.stdout)
    }
    if (result.stderr) {
        lines.push("", "Stderr preview:", result.stderr)
    }
    if (result.truncated) {
        lines.push("", "The preview was truncated.")
    }
    if (result.liveOutputTruncated) {
        lines.push("Live UI output was truncated.")
    }
    lines.push("", `Full output: ${result.outputPath}`)
    if (result.backgrounded) {
        lines.push(
            `Completion status: ${result.statusPath}`,
            "To wait for completion and read the result, run:",
            result.joinCommand ?? "",
        )
    } else {
        lines.push(
            `Size: ${result.stdoutBytes + result.stderrBytes} bytes`,
            `SHA-256: ${result.outputSha256}`,
        )
    }
    return lines.join("\n")
}

export class AgentSession {
    public readonly id: string = randomUUID()
    private readonly input: JsonObject[] = []
    private readonly steeringInput: JsonObject[] = []
    private activeController: AbortController | null = null
    private activeExecBackgroundController: AbortController | null = null
    private activeContextTokens: number | undefined
    private modelLimits: Promise<Map<string, number>> | null = null

    public constructor(private readonly options: AgentTurnOptions = {}, snapshot?: { sessionId: string, items: JsonObject[], contextTokens?: number }) {
        if (snapshot) {
            this.id = snapshot.sessionId
            this.input.push(...structuredClone(snapshot.items))
            this.activeContextTokens = snapshot.contextTokens
        }
    }

    public get active(): boolean {
        return this.activeController !== null
    }

    public contextSnapshot(): {
        sessionId: string
        active: boolean
        contextTokens?: number
        capturedAt: string
        items: JsonObject[]
    } {
        return {
            sessionId: this.id,
            active: this.active,
            contextTokens: this.activeContextTokens,
            capturedAt: new Date().toISOString(),
            items: structuredClone(this.input),
        }
    }

    public stop(): boolean {
        if (!this.activeController) {
            return false
        }
        this.steeringInput.splice(0)
        this.activeController.abort()
        return true
    }

    public steer(prompt: string): boolean {
        if (!this.activeController || this.activeController.signal.aborted || !prompt.trim()) {
            return false
        }
        this.steeringInput.push({
            role: "user",
            content: [{ type: "input_text", text: prompt }],
        })
        this.activeExecBackgroundController?.abort()
        return true
    }

    public async run(prompt: string, options: AgentTurnOptions = {}): Promise<string> {
        if (this.activeController) {
            throw new Error("Agent session already has an active turn")
        }
        if (!prompt.trim()) {
            throw new Error("Agent prompt must not be empty")
        }
        options = { ...this.options, ...options }
        for (const [name, value, minimum] of [["maxSteps", options.maxSteps, 1], ["maxRetries", options.maxRetries, 0]] as const) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
                throw new Error(`${name} must be an integer greater than or equal to ${minimum}`)
            }
        }
        const controller = new AbortController()
        this.activeController = controller
        const previousActiveContextTokens = this.activeContextTokens
        this.input.push({
            role: "user",
            content: [{ type: "input_text", text: prompt }],
        })
        const failedTurnInput = [...this.input]
        try {
            return await this.runTurn(options, controller.signal)
        } catch (error) {
            this.input.splice(0, this.input.length, ...failedTurnInput)
            this.activeContextTokens = previousActiveContextTokens
            throw error
        } finally {
            if (this.activeController === controller) {
                this.activeController = null
            }
        }
    }

    private async runTurn(options: AgentTurnOptions, signal: AbortSignal): Promise<string> {
        const cwd = resolve(options.cwd ?? process.env.PUPPYGPT_WORKDIR ?? process.cwd())
        const tools = [EXEC_TOOL, viewImageTool(cwd), WEB_SEARCH_TOOL, IMAGEGEN_TOOL]
        const fetchImpl = options.fetchImpl ?? fetch
        const endpoint = options.endpoint ?? process.env.PUPPYGPT_CODEX_ENDPOINT ?? DEFAULT_ENDPOINT
        const execute = options.execute ?? runExec
        const inspectImage = options.inspectImage ?? viewImage
        let auth = await getFreshAuth({
            authFile: options.authFile, authStorage: options.authStorage,
            issuer: options.issuer,
            fetchImpl,
        })
        const model = options.model ?? DEFAULT_MODEL
        const workspaceInstructions = options.loadWorkspaceInstructions
            ? await options.loadWorkspaceInstructions()
            : await readFile(join(cwd, "AGENTS.md"), "utf8").catch(error => {
                if (error.code === "ENOENT") return ""
                throw error
            })
        const instructions = [coreInstructions(cwd), options.instructions, workspaceInstructions].filter(Boolean).join("\n\n")
        const configuredContextWindow = options.contextWindow
            ?? Number.parseInt(process.env.PUPPYGPT_MODEL_CONTEXT_WINDOW ?? "", 10)

        const request = async (body: JsonObject, onEvent?: (event: JsonObject) => void | Promise<void>) => {
            let refreshedAuth = false
            let retries = 0
            while (true) {
                signal.throwIfAborted()
                try {
                    return await streamCodexResponse({
                        endpoint,
                        headers: requestHeaders(auth, this.id),
                        body,
                        fetchImpl,
                        signal,
                        onEvent,
                    })
                } catch (error) {
                    if (error instanceof HttpError && error.status === 401 && !refreshedAuth) {
                        auth = await getFreshAuth({
                            authFile: options.authFile, authStorage: options.authStorage,
                            issuer: options.issuer,
                            fetchImpl,
                            forceRefresh: true,
                        })
                        refreshedAuth = true
                        continue
                    }
                    if (!retryableRequestError(error) || retries >= (options.maxRetries ?? MAX_REQUEST_RETRIES)) {
                        throw error
                    }
                    const exponentialDelay = Math.min(RETRY_BASE_DELAY_MS * 2 ** retries, RETRY_MAX_DELAY_MS)
                    const delayMs = error instanceof HttpError && error.retryAfterMs !== undefined
                        ? error.retryAfterMs
                        : Math.min(
                            exponentialDelay + Math.floor(Math.random() * Math.max(1, exponentialDelay / 4)),
                            RETRY_MAX_DELAY_MS,
                        )
                    retries += 1
                    await waitForRetry(delayMs, signal)
                }
            }
        }

        const appendSteeringInput = (): boolean => {
            if (!this.steeringInput.length) {
                return false
            }
            this.input.push(...this.steeringInput.splice(0))
            return true
        }

        const compact = async (reason: "auto" | "context_overflow"): Promise<void> => {
            const compactionId = randomUUID()
            const contextTokens = this.activeContextTokens
            await options.onInteraction?.({ type: "compaction_start", compactionId, reason, contextTokens })
            const body: JsonObject = {
                model,
                input: [...this.input, { type: "compaction_trigger" }],
                instructions,
                tools,
                tool_choice: "auto",
                parallel_tool_calls: false,
                reasoning: {
                    effort: options.reasoningEffort ?? process.env.PUPPYGPT_MODEL_REASONING_EFFORT ?? "medium",
                    summary: "auto",
                },
                ...(options.fastMode ? { service_tier: "priority" } : {}),
                store: false,
                stream: true,
                include: RESPONSE_INCLUDES,
            }
            try {
                const response = await request(body)
                const compaction = response.output.filter(item => item.type === "compaction")
                if (response.output.length !== 1 || compaction.length !== 1) {
                    throw new Error(`Codex compaction returned ${compaction.length} checkpoint items`)
                }
                const retained: JsonObject[] = []
                let remaining = RETAINED_USER_MESSAGE_CHARS
                for (let index = this.input.length - 1; index >= 0 && remaining > 0; index -= 1) {
                    const item = this.input[index]
                    if (item?.role !== "user") {
                        continue
                    }
                    const size = JSON.stringify(item).length
                    if (size > remaining) {
                        continue
                    }
                    retained.unshift(item)
                    remaining -= size
                }
                this.input.splice(
                    0,
                    this.input.length,
                    ...retained,
                    compaction[0]!,
                )
                this.activeContextTokens = undefined
                await options.onInteraction?.({
                    type: "compaction_complete",
                    compactionId,
                    reason,
                    contextTokens,
                    retainedUserMessages: retained.length,
                })
            } catch (error) {
                await options.onInteraction?.({
                    type: "compaction_error",
                    compactionId,
                    reason,
                    contextTokens,
                    error: error instanceof Error ? error.message : String(error),
                })
                throw error
            }
        }

        const shouldCompact = async (): Promise<boolean> => {
            if (this.activeContextTokens === undefined) {
                return false
            }
            if (Number.isFinite(configuredContextWindow) && configuredContextWindow > 0) {
                return this.activeContextTokens >= Math.floor(configuredContextWindow * AUTO_COMPACT_PERCENT)
            }
            const fallbackContextWindow = DEFAULT_CONTEXT_WINDOWS[model]
            if (fallbackContextWindow && this.activeContextTokens < Math.floor(fallbackContextWindow * AUTO_COMPACT_PERCENT)) {
                return false
            }
            this.modelLimits ??= (async () => {
                try {
                    const headers = requestHeaders(auth, this.id)
                    headers.set("Accept", "application/json")
                    const modelsEndpoint = new URL(endpointFor(endpoint, "models"))
                    modelsEndpoint.searchParams.set(
                        "client_version",
                        process.env.PUPPYGPT_CODEX_CLIENT_VERSION ?? DEFAULT_CODEX_CLIENT_VERSION,
                    )
                    const response = await fetchImpl(modelsEndpoint, { headers, signal })
                    if (!response.ok) {
                        return new Map<string, number>()
                    }
                    const body = asObject(await response.json())
                    if (!body || !Array.isArray(body.models)) {
                        return new Map<string, number>()
                    }
                    const limits = new Map<string, number>()
                    for (const item of body.models) {
                        const entry = asObject(item)
                        const slug = asString(entry?.slug)
                        const contextWindow = asNumber(entry?.context_window) ?? asNumber(entry?.max_context_window)
                        if (!slug || !contextWindow || contextWindow <= 0) {
                            continue
                        }
                        const catalogLimit = asNumber(entry?.auto_compact_token_limit)
                        const defaultLimit = Math.floor(contextWindow * AUTO_COMPACT_PERCENT)
                        limits.set(slug, catalogLimit ? Math.min(catalogLimit, defaultLimit) : defaultLimit)
                    }
                    return limits
                } catch {
                    return new Map<string, number>()
                }
            })()
            const catalogLimit = (await this.modelLimits).get(model)
            const fallbackLimit = fallbackContextWindow
                ? Math.floor(fallbackContextWindow * AUTO_COMPACT_PERCENT)
                : undefined
            const limit = catalogLimit ?? fallbackLimit
            return limit !== undefined && this.activeContextTokens >= limit
        }

        let retriedAfterOverflow = false
        let completedToolCall = false
        const maxSteps = options.maxSteps
        for (let step = 0; maxSteps === undefined || step < maxSteps; step += 1) {
            if (await shouldCompact()) {
                await compact("auto")
            }
            appendSteeringInput()
            const body: JsonObject = {
                model,
                instructions,
                input: this.input,
                tools,
                tool_choice: "auto",
                parallel_tool_calls: false,
                reasoning: {
                    effort: options.reasoningEffort ?? process.env.PUPPYGPT_MODEL_REASONING_EFFORT ?? "medium",
                    summary: "auto",
                },
                ...(options.fastMode ? { service_tier: "priority" } : {}),
                store: false,
                stream: true,
                include: RESPONSE_INCLUDES,
            }
            await options.onInteraction?.({ type: "request", step: step + 1, body })
            const onResponseEvent = async (event: JsonObject): Promise<void> => {
                const type = asString(event.type)
                if (type === "response.output_text.delta") {
                    await options.onInteraction?.({ type: "text_delta", step: step + 1, text: asString(event.delta) ?? "" })
                    return
                }
                const callId = asString(event.item_id)
                const status = type?.slice("response.web_search_call.".length)
                if (!callId || (status !== "in_progress" && status !== "searching" && status !== "completed")) {
                    return
                }
                await options.onInteraction?.({ type: "web_search", step: step + 1, callId, status })
            }
            let response
            try {
                response = await request(body, onResponseEvent)
            } catch (error) {
                if (contextOverflow(error) && !retriedAfterOverflow) {
                    await compact("context_overflow")
                    retriedAfterOverflow = true
                    step -= 1
                    continue
                }
                throw error
            }
            retriedAfterOverflow = false
            await options.onInteraction?.({ type: "response", step: step + 1, response })

            this.input.push(...response.output)
            this.activeContextTokens = asNumber(response.usage?.total_tokens) ?? asNumber(response.usage?.input_tokens)
            const calls = response.output.filter(item => item.type === "function_call")
            if (!calls.length) {
                if (appendSteeringInput()) {
                    continue
                }
                const text = extractOutputText(response.output)
                if (!text) {
                    if (!completedToolCall) {
                        throw new Error("Codex completed without a final message")
                    }
                    await options.onInteraction?.({ type: "final", step: step + 1, text: TOOL_ONLY_COMPLETION_TEXT })
                    return TOOL_ONLY_COMPLETION_TEXT
                }
                await options.onInteraction?.({ type: "final", step: step + 1, text })
                return text
            }

            completedToolCall = true
            for (const call of calls) {
                let callId = asString(call.call_id) ?? "unknown"
                let output: string | JsonObject[]
                try {
                    const parsed = parseFunctionCall(call)
                    callId = parsed.callId
                    if (parsed.name === "imagegen") {
                        await options.onInteraction?.({ type: "imagegen_start", step: step + 1, callId, prompt: parsed.args.prompt })
                        const run = () => {
                            const headers = requestHeaders(auth, this.id)
                            headers.set("x-codex-image-turn-id", `${this.id}:${step + 1}`)
                            return generateImage({ args: parsed.args, cwd, endpoint, headers, history: this.input, fetchImpl, signal })
                        }
                        let image
                        try { image = await run() } catch (error) {
                            if (!(error instanceof HttpError) || error.status !== 401) throw error
                            auth = await getFreshAuth({ authFile: options.authFile, authStorage: options.authStorage, issuer: options.issuer, fetchImpl, forceRefresh: true })
                            image = await run()
                        }
                        await options.onInteraction?.({ type: "imagegen_result", step: step + 1, callId, path: image.path, prompt: parsed.args.prompt })
                        output = [
                            { type: "input_text", text: `Generated image saved to ${image.path}. It is displayed to the user automatically. Use this path for edits or to copy the asset into the project.` },
                            { type: "input_image", image_url: image.imageUrl, detail: "auto" },
                        ]
                        this.input.push({ type: "function_call_output", call_id: callId, output })
                        continue
                    }
                    if (parsed.name === "view_image") {
                        const imagePath = parsed.path
                        await options.onInteraction?.({ type: "image_start", step: step + 1, callId, path: imagePath })
                        const image = await inspectImage(imagePath, cwd)
                        await options.onInteraction?.({
                            type: "image_result",
                            step: step + 1,
                            callId,
                            path: image.path,
                            mimeType: image.mimeType,
                            size: image.size,
                        })
                        output = [
                            { type: "input_text", text: `Image loaded from ${image.path}` },
                            { type: "input_image", image_url: image.imageUrl, detail: "auto" },
                        ]
                        this.input.push({ type: "function_call_output", call_id: callId, output })
                        continue
                    }
                    const command = parsed.command
                    options.onToolCall?.(command)
                    const backgroundController = new AbortController()
                    this.activeExecBackgroundController = backgroundController
                    let result: ExecResult
                    try {
                        await options.onInteraction?.({
                            type: "tool_start",
                            step: step + 1,
                            callId,
                            command,
                        })
                        result = await execute({
                            command,
                            cwd,
                            callId,
                            timeoutMs: parsed.timeoutMs,
                            signal,
                            backgroundSignal: backgroundController.signal,
                            onOutput: chunk => options.onInteraction?.({
                                type: "tool_output",
                                step: step + 1,
                                callId,
                                chunk,
                            }),
                        })
                    } finally {
                        if (this.activeExecBackgroundController === backgroundController) {
                            this.activeExecBackgroundController = null
                        }
                    }
                    await options.onInteraction?.({
                        type: "tool_result",
                        step: step + 1,
                        callId,
                        command,
                        result,
                    })
                    output = formatExecResult(result)
                } catch (error) {
                    if (signal.aborted) {
                        throw error
                    }
                    await options.onInteraction?.({
                        type: "tool_error",
                        step: step + 1,
                        callId,
                        error: error instanceof Error ? error.message : String(error),
                    })
                    output = toolError(error)
                }
                this.input.push({ type: "function_call_output", call_id: callId, output })
            }
        }
        throw new Error(`Agent exceeded its ${maxSteps} step limit`)
    }
}

export const runAgent = async (options: RunAgentOptions): Promise<string> => {
    const session = new AgentSession()
    const { prompt, ...turnOptions } = options
    return session.run(prompt, turnOptions)
}
