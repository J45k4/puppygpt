import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentSession, runExec } from "./index"
import type { JsonObject } from "./types"

const directories: string[] = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const workspace = async () => {
    const cwd = await mkdtemp(join(tmpdir(), "puppygpt-workspace-"))
    directories.push(cwd)
    const authFile = join(cwd, "auth.json")
    const claims = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: `header.${claims}.signature`, refresh_token: "fake-refresh" },
    }))
    return { cwd, authFile }
}

const response = (output: JsonObject[]) => new Response(`data: ${JSON.stringify({
    type: "response.completed", response: { output },
})}\n\n`, { headers: { "Content-Type": "text/event-stream" } })

const answer = (text: string): JsonObject => ({
    type: "message", role: "assistant", content: [{ type: "output_text", text }],
})

test("session executes in its configured workspace and reloads instructions on follow-up", async () => {
    const { cwd, authFile } = await workspace()
    await Bun.write(join(cwd, "AGENTS.md"), "Workspace rule one")
    const requests: JsonObject[] = []
    const session = new AgentSession({
        cwd, authFile, instructions: "User-defined agent instruction", maxSteps: 4,
        fetchImpl: async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)))
            if (requests.length === 1) {
                return response([{
                    type: "function_call", name: "exec", call_id: "workspace-command",
                    arguments: JSON.stringify({ command: "pwd > result.txt; printf verified", timeout_ms: 1000 }),
                }])
            }
            return response([answer("Finished")])
        },
    })
    expect(await session.run("Inspect the workspace")).toBe("Finished")
    expect((await Bun.file(join(cwd, "result.txt")).text()).trim()).toBe(cwd)
    expect(await Bun.file(join(cwd, ".puppygpt/exec-results/workspace-command/output.log")).text()).toBe("verified")
    expect(requests[0]!.instructions).toContain("Workspace rule one")
    expect(requests[0]!.instructions).toContain("User-defined agent instruction")
    expect(requests[0]!.instructions).not.toContain("setacli")
    expect(JSON.stringify(requests[1]!.input)).toContain("verified")
    await Bun.write(join(cwd, "AGENTS.md"), "Workspace rule two")
    await session.run("Continue")
    expect(requests[2]!.instructions).toContain("Workspace rule two")
    expect(requests[2]!.instructions).not.toContain("Workspace rule one")
    const snapshot = session.contextSnapshot()
    snapshot.items.splice(0)
    expect(session.contextSnapshot().items.length).toBeGreaterThan(0)
})

test("malformed tool arguments produce a tool result without executing a command", async () => {
    const options = await workspace()
    let requests = 0
    let executions = 0
    const session = new AgentSession({
        ...options,
        execute: async () => { executions += 1; throw new Error("Must not execute") },
        fetchImpl: async (_url, init) => {
            requests += 1
            if (requests === 1) return response([{
                type: "function_call", name: "exec", call_id: "bad-arguments", arguments: "{invalid",
            }])
            const body = JSON.parse(String(init?.body))
            expect(body.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "bad-arguments" })
            expect(body.input.at(-1).output).toContain("could not be executed")
            return response([answer("Recovered")])
        },
    })
    expect(await session.run("Try a tool")).toBe("Recovered")
    expect(executions).toBe(0)
})

test("explicit retry budget stops transient failures", async () => {
    const options = await workspace()
    let requests = 0
    const session = new AgentSession({
        ...options, maxRetries: 1,
        fetchImpl: async () => {
            requests += 1
            return new Response("busy", { status: 503, headers: { "Retry-After": "0" } })
        },
    })
    await expect(session.run("Try")).rejects.toThrow("503")
    expect(requests).toBe(2)
    expect(session.active).toBeFalse()
})

test("invalid prompts and limits fail before starting a turn", async () => {
    const session = new AgentSession()
    await expect(session.run("  ")).rejects.toThrow("must not be empty")
    await expect(session.run("Try", { maxSteps: Number.NaN })).rejects.toThrow("maxSteps")
    await expect(session.run("Try", { maxRetries: -1 })).rejects.toThrow("maxRetries")
    expect(session.contextSnapshot().items).toEqual([])
    expect(session.active).toBeFalse()
})

test("a pre-cancelled exec cannot produce side effects", async () => {
    const { cwd } = await workspace()
    const controller = new AbortController()
    controller.abort()
    await expect(runExec({ cwd, command: "touch should-not-exist", signal: controller.signal })).rejects.toHaveProperty("name", "AbortError")
    expect(await Bun.file(join(cwd, "should-not-exist")).exists()).toBeFalse()
})
