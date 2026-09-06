import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentSession, runAgent, type AgentInteraction } from "./agent"
import { runExec } from "./exec"
import type { FetchLike, JsonObject } from "./types"

const jwt = (claims: Record<string, unknown>): string => {
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url")
    return `header.${encoded}.signature`
}

const sse = (events: JsonObject[]): Response => new Response(
    `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
)

const compactSse = (encryptedContent: string): Response => sse([
    {
        type: "response.output_item.done",
        item: { type: "compaction", encrypted_content: encryptedContent },
    },
    { type: "response.completed", response: { id: `response-${encryptedContent}` } },
])

test("agent executes a tool call and sends its output back to Codex", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
            access_token: jwt({ exp: 2_000_000_000 }),
            refresh_token: "refresh-1",
            account_id: "account-1",
        },
    }))
    const responses = [
        sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "function_call",
                    name: "exec",
                    call_id: "call-1",
                    arguments: JSON.stringify({ command: "printf hello", timeout_ms: null }),
                },
            },
            { type: "response.completed", response: { id: "response-1" } },
        ]),
        sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Finished" }],
                },
            },
            { type: "response.completed", response: { id: "response-2" } },
        ]),
    ]
    const bodies: JsonObject[] = []
    const headers: Headers[] = []
    const fetchImpl: FetchLike = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        headers.push(new Headers(init?.headers))
        const response = responses.shift()
        if (!response) {
            throw new Error("Unexpected request")
        }
        return response
    }
    const commands: string[] = []
    const workingDirectories: string[] = []
    let instructionLoads = 0
    const interactions: AgentInteraction[] = []

    try {
        const result = await runAgent({
            prompt: "Say hello",
            authFile,
            endpoint: "https://codex.example.test/responses",
            fastMode: true,
            fetchImpl,
            loadWorkspaceInstructions: async () => {
                instructionLoads += 1
                return "Reusable skills are installed under ~/.agents/skills."
            },
            execute: async input => {
                commands.push(input.command)
                workingDirectories.push(input.cwd)
                return {
                    exitCode: 0,
                    stdout: "hello",
                    stderr: "",
                    stdoutBytes: 5,
                    stderrBytes: 0,
                    outputPath: "/work/.puppygpt/exec-results/call-1/output.log",
                    outputSha256: "abc123",
                    timedOut: false,
                    durationMs: 1,
                    truncated: false,
                    liveOutputTruncated: false,
                }
            },
            onInteraction: interaction => { interactions.push(interaction) },
        })

        expect(result).toBe("Finished")
        expect(instructionLoads).toBe(1)
        expect(commands).toEqual(["printf hello"])
        expect(workingDirectories).toEqual([process.cwd()])
        expect(headers[0]!.get("Authorization")).toBe(`Bearer ${jwt({ exp: 2_000_000_000 })}`)
        expect(headers[0]!.get("ChatGPT-Account-ID")).toBe("account-1")
        expect(headers[0]!.get("originator")).toBe("puppygpt")
        expect(bodies[0]!.service_tier).toBe("priority")
        expect(bodies[0]!.instructions).toContain("Find and read every other AGENTS.md")
        expect(bodies[0]!.instructions).toContain("Reusable skills are installed under ~/.agents/skills")
        expect(bodies[0]!.instructions).not.toContain("Before starting work, read /work/AGENTS.md")
        const tool = (bodies[0]!.tools as JsonObject[])[0]!
        expect(tool.name).toBe("exec")
        expect((tool.parameters as JsonObject).required).toEqual(["command", "timeout_ms", "target"])
        const secondInput = bodies[1]!.input as JsonObject[]
        const toolOutput = secondInput.find(item => item.type === "function_call_output")
        expect(String(toolOutput?.output)).toContain("hello")
        expect(String(toolOutput?.output)).toContain("Full output: /work/.puppygpt/exec-results/call-1/output.log")
        expect(String(toolOutput?.output)).not.toStartWith("{")
        expect(interactions.map(interaction => interaction.type)).toEqual([
            "checkpoint", "request", "response", "tool_start", "tool_result",
            "checkpoint", "request", "response", "checkpoint", "final",
        ])
        const checkpoints = interactions.filter(interaction => interaction.type === "checkpoint")
        expect(checkpoints[0]?.snapshot.items.at(-1)?.role).toBe("user")
        expect(checkpoints[1]?.snapshot.items.some(item => item.type === "function_call_output")).toBeTrue()
        expect(checkpoints[2]?.snapshot.items.at(-1)?.role).toBe("assistant")
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent retries an overloaded request before returning the response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-retry-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0

    try {
        const result = await runAgent({
            prompt: "Try the request",
            authFile,
            fetchImpl: async () => {
                requestCount += 1
                if (requestCount === 1) {
                    return new Response("Server is overloaded", {
                        status: 503,
                        headers: { "Retry-After": "0" },
                    })
                }
                return sse([
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "Succeeded after retry" }],
                        },
                    },
                    { type: "response.completed", response: { id: "response-retried" } },
                ])
            },
        })

        expect(result).toBe("Succeeded after retry")
        expect(requestCount).toBe(2)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent retries when the Responses API request has a network failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-network-retry-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0

    try {
        const result = await runAgent({
            prompt: "Try the request",
            authFile,
            fetchImpl: async () => {
                requestCount += 1
                if (requestCount === 1) {
                    throw new TypeError("Unable to connect to the Responses API")
                }
                return sse([
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "Succeeded after network retry" }],
                        },
                    },
                    { type: "response.completed", response: { id: "response-retried" } },
                ])
            },
        })

        expect(result).toBe("Succeeded after network retry")
        expect(requestCount).toBe(2)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent retries when the Responses API stream fails in the middle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-midstream-retry-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0

    try {
        const result = await runAgent({
            prompt: "Try the request",
            authFile,
            fetchImpl: async () => {
                requestCount += 1
                if (requestCount === 1) {
                    let sentChunk = false
                    return new Response(new ReadableStream({
                        pull(controller) {
                            if (!sentChunk) {
                                sentChunk = true
                                controller.enqueue(new TextEncoder().encode(
                                    `data: ${JSON.stringify({ type: "response.created" })}\n\n`,
                                ))
                                return
                            }
                            controller.error(new TypeError("Response stream connection was reset"))
                        },
                    }), { headers: { "Content-Type": "text/event-stream" } })
                }
                return sse([
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "Succeeded after stream retry" }],
                        },
                    },
                    { type: "response.completed", response: { id: "response-retried" } },
                ])
            },
        })

        expect(result).toBe("Succeeded after stream retry")
        expect(requestCount).toBe(2)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent retries a failed response before returning the response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-failed-response-retry-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0

    try {
        const result = await runAgent({
            prompt: "Try the request",
            authFile,
            fetchImpl: async () => {
                requestCount += 1
                if (requestCount === 1) {
                    return sse([{
                        type: "response.failed",
                        response: { error: { message: "Response generation failed" } },
                    }])
                }
                return sse([
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "output_text", text: "Succeeded after failed response" }],
                        },
                    },
                    { type: "response.completed", response: { id: "response-retried" } },
                ])
            },
        })

        expect(result).toBe("Succeeded after failed response")
        expect(requestCount).toBe(2)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent returns model refusal text without retrying", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-model-refusal-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0

    try {
        const result = await runAgent({
            prompt: "Try the request",
            authFile,
            fetchImpl: async () => {
                requestCount += 1
                return sse([
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [{ type: "refusal", refusal: "Request refused" }],
                        },
                    },
                    { type: "response.completed", response: { id: "response-refused" } },
                ])
            },
        })
        expect(result).toBe("Request refused")
        expect(requestCount).toBe(1)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent stops retrying after the extended overload retry window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-retry-limit-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0

    try {
        await expect(runAgent({
            prompt: "Try the request",
            authFile,
            fetchImpl: async () => {
                requestCount += 1
                return new Response("Server is overloaded", {
                    status: 503,
                    headers: { "Retry-After": "0" },
                })
            },
        })).rejects.toThrow("Codex request failed with status 503: Server is overloaded")
        expect(requestCount).toBe(361)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent returns view_image output as visual model input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-image-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const responses = [
        sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "function_call",
                    name: "view_image",
                    call_id: "image-1",
                    arguments: JSON.stringify({ path: "/work/screenshot.png" }),
                },
            },
            { type: "response.completed", response: { id: "response-image" } },
        ]),
        sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "The screenshot is blue." }],
                },
            },
            { type: "response.completed", response: { id: "response-final" } },
        ]),
    ]
    const bodies: JsonObject[] = []
    const interactions: AgentInteraction[] = []

    try {
        const result = await runAgent({
            prompt: "Inspect the screenshot",
            authFile,
            fetchImpl: async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)))
                const response = responses.shift()
                if (!response) {
                    throw new Error("Unexpected request")
                }
                return response
            },
            inspectImage: async path => ({
                path,
                mimeType: "image/png",
                size: 3,
                imageUrl: "data:image/png;base64,YWJj",
            }),
            onInteraction: interaction => { interactions.push(interaction) },
        })

        expect(result).toBe("The screenshot is blue.")
        expect((bodies[0]!.tools as JsonObject[]).map(tool => tool.name ?? tool.type)).toEqual(["exec", "view_image", "web_search", "imagegen"])
        const imageOutput = (bodies[1]!.input as JsonObject[]).find(item => item.type === "function_call_output")
        expect(imageOutput?.output).toEqual([
            { type: "input_text", text: "Image loaded from /work/screenshot.png" },
            { type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "auto" },
        ])
        expect(interactions).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "image_start", path: "/work/screenshot.png" }),
            expect.objectContaining({ type: "image_result", mimeType: "image/png", size: 3 }),
        ]))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent exposes hosted web search and retains lifecycle events and citations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-web-search-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const bodies: JsonObject[] = []
    const interactions: AgentInteraction[] = []

    try {
        const result = await runAgent({
            prompt: "Find the latest example",
            authFile,
            fetchImpl: async (_input, init) => {
                bodies.push(JSON.parse(String(init?.body)))
                return sse([
                    { type: "response.web_search_call.in_progress", item_id: "search-1" },
                    { type: "response.web_search_call.searching", item_id: "search-1" },
                    { type: "response.web_search_call.completed", item_id: "search-1" },
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "web_search_call",
                            id: "search-1",
                            status: "completed",
                            action: {
                                type: "search",
                                query: "latest example",
                                sources: [{ type: "url", url: "https://example.com/article", title: "Example article" }],
                            },
                        },
                    },
                    {
                        type: "response.output_item.done",
                        item: {
                            type: "message",
                            role: "assistant",
                            content: [{
                                type: "output_text",
                                text: "Latest news",
                                annotations: [{
                                    type: "url_citation",
                                    start_index: 0,
                                    end_index: 11,
                                    url: "https://example.com/article",
                                    title: "Example article",
                                }],
                            }],
                        },
                    },
                    { type: "response.completed", response: { id: "response-search" } },
                ])
            },
            onInteraction: interaction => { interactions.push(interaction) },
        })

        expect(result).toBe("[Latest news](https://example.com/article)")
        expect((bodies[0]!.tools as JsonObject[]).map(tool => tool.name ?? tool.type)).toContain("web_search")
        expect(bodies[0]!.include).toContain("web_search_call.action.sources")
        expect(interactions).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: "web_search", callId: "search-1", status: "in_progress" }),
            expect.objectContaining({ type: "web_search", callId: "search-1", status: "searching" }),
            expect.objectContaining({ type: "web_search", callId: "search-1", status: "completed" }),
            expect.objectContaining({ type: "final", text: "[Latest news](https://example.com/article)" }),
        ]))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent continues past 16 tool calls by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-unlimited-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0
    const commands: string[] = []
    const fetchImpl: FetchLike = async () => {
        requestCount += 1
        if (requestCount <= 17) {
            return sse([
                {
                    type: "response.output_item.done",
                    item: {
                        type: "function_call",
                        name: "exec",
                        call_id: `call-${requestCount}`,
                        arguments: JSON.stringify({ command: `printf ${requestCount}`, timeout_ms: null }),
                    },
                },
                { type: "response.completed", response: { id: `response-${requestCount}` } },
            ])
        }
        if (requestCount === 18) {
            return sse([
                {
                    type: "response.output_item.done",
                    item: {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "Finished after 17 tools" }],
                    },
                },
                { type: "response.completed", response: { id: "response-final" } },
            ])
        }
        throw new Error("Unexpected request")
    }

    try {
        const result = await runAgent({
            prompt: "Keep working",
            authFile,
            fetchImpl,
            execute: async input => {
                commands.push(input.command)
                return {
                    exitCode: 0,
                    stdout: "ok",
                    stderr: "",
                    stdoutBytes: 2,
                    stderrBytes: 0,
                    outputPath: "/work/.puppygpt/exec-results/test/output.log",
                    outputSha256: "abc123",
                    timedOut: false,
                    durationMs: 1,
                    truncated: false,
                    liveOutputTruncated: false,
                }
            },
        })

        expect(result).toBe("Finished after 17 tools")
        expect(commands).toHaveLength(17)
        expect(requestCount).toBe(18)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent honors an explicit step limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-agent-limited-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0
    const fetchImpl: FetchLike = async () => {
        requestCount += 1
        return sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "function_call",
                    name: "exec",
                    call_id: `call-${requestCount}`,
                    arguments: JSON.stringify({ command: "true", timeout_ms: null }),
                },
            },
            { type: "response.completed", response: { id: `response-${requestCount}` } },
        ])
    }

    try {
        await expect(runAgent({
            prompt: "Keep working",
            authFile,
            maxSteps: 2,
            fetchImpl,
            execute: async () => ({
                exitCode: 0,
                stdout: "",
                stderr: "",
                stdoutBytes: 0,
                stderrBytes: 0,
                outputPath: "/work/.puppygpt/exec-results/test/output.log",
                outputSha256: "abc123",
                timedOut: false,
                durationMs: 1,
                truncated: false,
                liveOutputTruncated: false,
            }),
        })).rejects.toThrow("Agent exceeded its 2 step limit")
        expect(requestCount).toBe(2)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("exec captures exit status and both output streams", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-exec-"))
    try {
        const result = await runExec({
            command: "printf hello\nprintf problem >&2\nexit 3",
            cwd: process.cwd(),
            callId: "call-streams",
            outputDirectory: directory,
            timeoutMs: 1000,
        })

        expect(result.exitCode).toBe(3)
        expect(result.stdout).toBe("hello")
        expect(result.stderr).toBe("problem")
        expect(result.timedOut).toBeFalse()
        expect(result.outputPath).toBe(join(directory, "call-streams", "output.log"))
        const fullOutput = await readFile(result.outputPath, "utf8")
        expect(fullOutput).toContain("hello")
        expect(fullOutput).toContain("problem")
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("exec kills a timed-out command and its subprocesses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-timeout-"))
    try {
        const result = await runExec({
            command: "sleep 10 & wait",
            cwd: process.cwd(),
            outputDirectory: directory,
            timeoutMs: 100,
        })

        expect(result.timedOut).toBeTrue()
        expect(result.durationMs).toBeLessThan(2000)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("exec streams bounded unicode-safe chunks and stores complete large output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-large-output-"))
    const chunks: Array<{ stream: string, offset: number, text: string }> = []
    try {
        const result = await runExec({
            command: "for i in {1..70000}; do printf '🙂'; done",
            cwd: process.cwd(),
            callId: "call-large-output",
            outputDirectory: directory,
            timeoutMs: 10_000,
            onOutput: chunk => { chunks.push(chunk) },
        })

        expect(result.exitCode).toBe(0)
        expect(result.truncated).toBeTrue()
        expect(result.liveOutputTruncated).toBeTrue()
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8 * 1024)
        expect(result.stdout).not.toContain("�")
        expect(chunks.length).toBeGreaterThan(1)
        expect(chunks.every(chunk => Buffer.byteLength(chunk.text) <= 8 * 1024)).toBeTrue()
        expect(chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0)).toBeLessThanOrEqual(256 * 1024)
        expect(chunks.every(chunk => !chunk.text.includes("�"))).toBeTrue()
        const fullOutput = await readFile(result.outputPath)
        expect(fullOutput.byteLength).toBe(280_000)
        expect(result.stdoutBytes).toBe(280_000)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("a cancelled session returns to idle and can run another turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-session-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    let requestCount = 0
    const fetchImpl: FetchLike = async (_input, init) => {
        requestCount += 1
        if (requestCount === 1) {
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")))
            })
        }
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered" }] },
            },
            { type: "response.completed", response: { id: "response-recovered" } },
        ])
    }
    const session = new AgentSession()
    try {
        const cancelled = session.run("Wait", { authFile, fetchImpl })
        await new Promise(resolve => setTimeout(resolve, 5))
        expect(session.stop()).toBeTrue()
        await expect(cancelled).rejects.toHaveProperty("name", "AbortError")
        expect(session.active).toBeFalse()
        await expect(session.run("Continue", { authFile, fetchImpl })).resolves.toBe("Recovered")
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("a failed turn preserves its user prompt for the next turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-failed-turn-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const bodies: JsonObject[] = []
    let requestCount = 0
    const fetchImpl: FetchLike = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        requestCount += 1
        if (requestCount === 1) {
            return new Response("Invalid request", { status: 400 })
        }
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Retried" }] },
            },
            { type: "response.completed", response: { id: "response-retried" } },
        ])
    }
    const session = new AgentSession()

    try {
        await expect(session.run("Original task", { authFile, fetchImpl })).rejects.toThrow("status 400")
        await expect(session.run("Try again", { authFile, fetchImpl })).resolves.toBe("Retried")
        expect(bodies[1]!.input).toEqual([
            { role: "user", content: [{ type: "input_text", text: "Original task" }] },
            { role: "user", content: [{ type: "input_text", text: "Try again" }] },
        ])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("tool-only completion preserves context for the next turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-tool-only-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const bodies: JsonObject[] = []
    const responses = [
        sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "function_call",
                    name: "exec",
                    call_id: "call-final-notification",
                },
            },
            { type: "response.completed", response: { id: "response-tool" } },
        ]),
        sse([
            { type: "response.completed", response: { id: "response-empty" } },
        ]),
        sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Follow-up answer" }],
                },
            },
            { type: "response.completed", response: { id: "response-follow-up" } },
        ]),
    ]
    const fetchImpl: FetchLike = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        const response = responses.shift()
        if (!response) {
            throw new Error("Unexpected request")
        }
        return response
    }
    const session = new AgentSession()

    try {
        await expect(session.run("Schedule this every weekday", {
            authFile,
            fetchImpl,
            execute: async () => ({
                exitCode: 0,
                stdout: "Sent final Slack message",
                stderr: "",
                stdoutBytes: 24,
                stderrBytes: 0,
                outputPath: "/work/.puppygpt/exec-results/call-final-notification/output.log",
                outputSha256: "abc123",
                timedOut: false,
                durationMs: 1,
                truncated: false,
                liveOutputTruncated: false,
            }),
        })).resolves.toBe("Done.")
        await expect(session.run("Helsinki", { authFile, fetchImpl })).resolves.toBe("Follow-up answer")

        const followUpInput = bodies[2]!.input as JsonObject[]
        expect(followUpInput).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([expect.objectContaining({ text: "Schedule this every weekday" })]),
            }),
            expect.objectContaining({ type: "function_call", call_id: "call-final-notification" }),
            expect.objectContaining({ type: "function_call_output", call_id: "call-final-notification" }),
            expect.objectContaining({
                role: "user",
                content: expect.arrayContaining([expect.objectContaining({ text: "Helsinki" })]),
            }),
        ]))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("retained sessions include prior conversation in follow-up turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-follow-up-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const bodies: JsonObject[] = []
    const responses = ["First answer", "Second answer"]
    const fetchImpl: FetchLike = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        const text = responses.shift()
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            },
            { type: "response.completed", response: { id: `response-${bodies.length}` } },
        ])
    }
    const session = new AgentSession()
    try {
        await expect(session.run("First question", { authFile, fetchImpl })).resolves.toBe("First answer")
        await expect(session.run("Follow-up question", { authFile, fetchImpl })).resolves.toBe("Second answer")
        const followUpInput = bodies[1]!.input as JsonObject[]
        expect(followUpInput).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ text: "First question" })]) }),
            expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ text: "First answer" })]) }),
            expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ text: "Follow-up question" })]) }),
        ]))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("steering received during a turn is included in the next model call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-steering-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const bodies: JsonObject[] = []
    let releaseFirstResponse!: () => void
    const firstResponseReady = new Promise<void>(resolve => {
        releaseFirstResponse = resolve
    })
    const fetchImpl: FetchLike = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) {
            await firstResponseReady
        }
        const text = bodies.length === 1 ? "Initial answer" : "Adjusted answer"
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            },
            { type: "response.completed", response: { id: `response-${bodies.length}` } },
        ])
    }
    const session = new AgentSession()
    try {
        const result = session.run("Implement it", { authFile, fetchImpl })
        while (!bodies.length) {
            await new Promise(resolve => setTimeout(resolve, 0))
        }
        expect(session.steer("Use the simpler approach")).toBeTrue()
        releaseFirstResponse()

        await expect(result).resolves.toBe("Adjusted answer")
        expect(bodies).toHaveLength(2)
        expect(bodies[1]!.input).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ text: "Initial answer" })]) }),
            expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ text: "Use the simpler approach" })]) }),
        ]))
        expect(session.steer("Too late")).toBeFalse()
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent replaces active history with server-compacted output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-compaction-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const urls: string[] = []
    const bodies: JsonObject[] = []
    const interactions: AgentInteraction[] = []
    const compacted = { type: "compaction", encrypted_content: "checkpoint-1" }
    const fetchImpl: FetchLike = async (input, init) => {
        const url = String(input)
        urls.push(url)
        const body = JSON.parse(String(init?.body)) as JsonObject
        bodies.push(body)
        const inputItems = body.input as JsonObject[]
        if (inputItems.at(-1)?.type === "compaction_trigger") {
            return compactSse("checkpoint-1")
        }
        const responseNumber = bodies.filter(item => (item.input as JsonObject[]).at(-1)?.type !== "compaction_trigger").length
        const text = responseNumber === 1 ? "First answer" : "Second answer"
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            },
            {
                type: "response.completed",
                response: { id: `response-${responseNumber}`, usage: { total_tokens: 91 } },
            },
        ])
    }
    const session = new AgentSession()
    try {
        await expect(session.run("First question", {
            authFile,
            endpoint: "https://codex.example.test/responses",
            contextWindow: 100,
            fetchImpl,
            loadWorkspaceInstructions: async () => "Compaction workspace rule",
        })).resolves.toBe("First answer")
        await expect(session.run("Follow-up question", {
            authFile,
            endpoint: "https://codex.example.test/responses",
            contextWindow: 100,
            fetchImpl,
            loadWorkspaceInstructions: async () => "Compaction workspace rule",
            onInteraction: interaction => { interactions.push(interaction) },
        })).resolves.toBe("Second answer")

        expect(urls).toEqual([
            "https://codex.example.test/responses",
            "https://codex.example.test/responses",
            "https://codex.example.test/responses",
        ])
        const compactInput = bodies[1]!.input as JsonObject[]
        expect(compactInput.some(item => item.type === "message" && item.role === "assistant")).toBeTrue()
        expect(compactInput.some(item => item.role === "user")).toBeTrue()
        expect(bodies[1]!.instructions).toContain("Find and read every other AGENTS.md")
        expect(bodies[1]!.instructions).toContain("Compaction workspace rule")
        expect(bodies[2]!.input).toEqual(expect.arrayContaining([compacted]))
        expect(bodies[2]!.instructions).toContain("Find and read every other AGENTS.md")
        expect(bodies[2]!.instructions).toContain("Compaction workspace rule")
        expect((bodies[2]!.input as JsonObject[]).some(item => item.role === "assistant")).toBeFalse()
        expect(interactions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "compaction_start",
                reason: "auto",
                contextTokens: 91,
            }),
            expect.objectContaining({
                type: "compaction_complete",
                reason: "auto",
                contextTokens: 91,
                retainedUserMessages: 2,
            }),
        ]))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent compacts and retries once after a context overflow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-overflow-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const urls: string[] = []
    const fetchImpl: FetchLike = async (input, init) => {
        const url = String(input)
        urls.push(url)
        const body = JSON.parse(String(init?.body)) as JsonObject
        const inputItems = body.input as JsonObject[]
        if (inputItems.at(-1)?.type === "compaction_trigger") {
            return compactSse("checkpoint-overflow")
        }
        if (urls.length === 1) {
            return new Response("maximum context length exceeded", { status: 400 })
        }
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Recovered" }] },
            },
            { type: "response.completed", response: { id: "response-recovered" } },
        ])
    }
    const session = new AgentSession()
    try {
        await expect(session.run("Continue a large thread", {
            authFile,
            endpoint: "https://codex.example.test/responses",
            fetchImpl,
        })).resolves.toBe("Recovered")
        expect(urls).toEqual([
            "https://codex.example.test/responses",
            "https://codex.example.test/responses",
            "https://codex.example.test/responses",
        ])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent uses the Codex model catalog auto-compaction limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-catalog-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const urls: string[] = []
    let regularResponseCount = 0
    const fetchImpl: FetchLike = async (input, init) => {
        const url = String(input)
        urls.push(url)
        if (url.includes("/models?")) {
            return Response.json({
                models: [{ slug: "test-model", context_window: 100, auto_compact_token_limit: 80 }],
            })
        }
        const body = JSON.parse(String(init?.body)) as JsonObject
        const inputItems = body.input as JsonObject[]
        if (inputItems.at(-1)?.type === "compaction_trigger") {
            return compactSse("checkpoint-catalog")
        }
        regularResponseCount += 1
        return sse([
            {
                type: "response.output_item.done",
                item: {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: regularResponseCount === 1 ? "First" : "Second" }],
                },
            },
            {
                type: "response.completed",
                response: { id: `response-${regularResponseCount}`, usage: { total_tokens: 81 } },
            },
        ])
    }
    const session = new AgentSession()
    try {
        await session.run("First question", {
            model: "test-model",
            authFile,
            endpoint: "https://codex.example.test/responses",
            fetchImpl,
        })
        await expect(session.run("Follow-up question", {
            model: "test-model",
            authFile,
            endpoint: "https://codex.example.test/responses",
            fetchImpl,
        })).resolves.toBe("Second")
        expect(urls).toEqual([
            "https://codex.example.test/responses",
            "https://codex.example.test/models?client_version=0.147.0",
            "https://codex.example.test/responses",
            "https://codex.example.test/responses",
        ])
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("exec moves a running command to the background without stopping it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-background-exec-"))
    const backgroundController = new AbortController()
    const releasePath = join(directory, "release")
    try {
        const resultPromise = runExec({
            command: `while [ ! -f '${releasePath}' ]; do sleep 0.01; done; printf finished`,
            cwd: process.cwd(),
            callId: "call-background",
            outputDirectory: directory,
            timeoutMs: 2000,
            backgroundSignal: backgroundController.signal,
        })
        setTimeout(() => backgroundController.abort(), 20)
        const result = await resultPromise

        expect(result.backgrounded).toBeTrue()
        expect(result.exitCode).toBeNull()
        expect(result.joinCommand).toContain(result.statusPath ?? "missing-status")
        expect(await Bun.file(result.statusPath ?? "").exists()).toBeFalse()
        await Bun.write(releasePath, "continue")
        await Bun.$`bash -lc ${result.joinCommand ?? "exit 1"}`.quiet()
        expect(await readFile(result.outputPath, "utf8")).toBe("finished")
        expect(JSON.parse(await readFile(result.statusPath ?? "", "utf8"))).toEqual(expect.objectContaining({
            exitCode: 0,
            timedOut: false,
            outputPath: result.outputPath,
        }))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("steering an active turn backgrounds its exec command and reaches the next model request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-steered-exec-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "refresh-1" },
    }))
    const bodies: JsonObject[] = []
    const releasePath = join(directory, "release")
    let requestCount = 0
    const fetchImpl: FetchLike = async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        requestCount += 1
        if (requestCount === 1) {
            return sse([
                {
                    type: "response.output_item.done",
                    item: {
                        type: "function_call",
                        name: "exec",
                        call_id: "call-steered",
                        arguments: JSON.stringify({
                            command: `while [ ! -f '${releasePath}' ]; do sleep 0.01; done; printf complete`,
                            timeout_ms: 2000,
                        }),
                    },
                },
                { type: "response.completed", response: { id: "response-command" } },
            ])
        }
        return sse([
            {
                type: "response.output_item.done",
                item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Changed direction" }] },
            },
            { type: "response.completed", response: { id: "response-steered" } },
        ])
    }
    const session = new AgentSession()
    let markToolStarted = () => {}
    const toolStarted = new Promise<void>(resolve => {
        markToolStarted = resolve
    })
    try {
        const response = session.run("Start the command", {
            authFile,
            fetchImpl,
            execute: input => runExec({ ...input, outputDirectory: directory }),
            onInteraction: interaction => {
                if (interaction.type === "tool_start") {
                    markToolStarted()
                }
            },
        })
        await toolStarted
        expect(session.steer("Change direction now")).toBeTrue()
        await expect(response).resolves.toBe("Changed direction")
        expect(JSON.stringify(bodies[1]!)).toContain("Change direction now")
        expect(JSON.stringify(bodies[1]!)).toContain("still running in the background")
        expect(await Bun.file(join(directory, "call-steered", "status.json")).exists()).toBeFalse()
        await Bun.write(releasePath, "continue")
        await Bun.$`bash -lc ${`while [ ! -f '${join(directory, "call-steered", "status.json")}' ]; do sleep 0.05; done`}`.quiet()
        expect(await readFile(join(directory, "call-steered", "output.log"), "utf8")).toBe("complete")
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test("agent exposes only runtime targets and rejects a model request for unauthorized host execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "puppygpt-target-policy-"))
    const authFile = join(directory, "auth.json")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt({ exp: 2_000_000_000 }), refresh_token: "test-refresh" } }))
    let requests = 0, executions = 0
    try {
        await runAgent({ cwd: directory, authFile, prompt: "Run a command", executionPolicy: { defaultTarget: "box", targets: [{ id: "box", kind: "docker", image: "test:local", workspaceRoot: directory }] },
            execute: async () => { executions++; throw new Error("Must not execute") },
            fetchImpl: async (_url, init) => {
                const body = JSON.parse(String(init?.body))
                if (requests++ === 0) {
                    expect(body.tools[0].parameters.properties.target.enum).toEqual(["box"])
                    return sse([{ type: "response.output_item.done", item: { type: "function_call", call_id: "denied", name: "exec", arguments: JSON.stringify({ target: "host", command: "echo escape", timeout_ms: null }) } }, { type: "response.completed", response: {} }])
                }
                expect(JSON.stringify(body.input)).toContain("Execution target is not allowed: host")
                return sse([{ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Host is unavailable." }] } }, { type: "response.completed", response: {} }])
            },
        })
        expect(executions).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
})
