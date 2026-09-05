import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatStore } from "./chats"
import { createChatApi } from "./chat-api"
import type { JsonObject } from "./agent/types"

const directories: string[] = []
const stores: ChatStore[] = []
afterEach(async () => {
    for (const store of stores.splice(0)) await store.close()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
    const cwd = await mkdtemp(join(tmpdir(), "puppygpt-chats-"))
    directories.push(cwd)
    const authFile = join(cwd, "auth.json")
    const claims = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `header.${claims}.sig`, refresh_token: "fake" } }))
    return { cwd, authFile }
}

function sse(output: JsonObject[], text?: string) {
    const events = [
        ...(text ? [{ type: "response.output_text.delta", delta: text }] : []),
        { type: "response.completed", response: { output } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
}
const answer = (text: string): JsonObject => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })

test("chat API executes tools, streams text, and restores agent context from SQLite", async () => {
    const { cwd, authFile } = await fixture()
    const database = join(cwd, "chats.sqlite")
    const requests: JsonObject[] = []
    const options = { authFile, fetchImpl: async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        if (requests.length === 1) return sse([{
            type: "function_call", name: "exec", call_id: "test-command", arguments: JSON.stringify({ command: "printf chat-proof", timeout_ms: 1000 }),
        }])
        return sse([answer("**Verified** chat-proof")], "**Verified** chat-proof")
    } }
    const store = new ChatStore(new Database(database), cwd, options)
    stores.push(store)
    const api = createChatApi(store)
    const created = await api(new Request("http://localhost/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(created.status).toBe(201)
    const chat = await created.json()
    const result = await api(new Request(`http://localhost/api/chats/${chat.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "Verify the chat" }) }))
    expect(result.status).toBe(202)
    await store.settled()
    expect(store.get(chat.id)?.status).toBe("idle")
    expect(store.get(chat.id)?.messages.filter(item => item.role === "assistant")).toHaveLength(1)
    expect(store.get(chat.id)?.messages.find(item => item.role === "activity")?.detail).toContain("chat-proof")
    expect(JSON.stringify(requests[1]!.input)).toContain("chat-proof")
    stores.splice(stores.indexOf(store), 1)
    await store.close()
    const reopened = new ChatStore(new Database(database), cwd, options)
    stores.push(reopened)
    reopened.send(chat.id, "What did we verify?")
    await reopened.settled()
    expect(JSON.stringify(requests[2]!.input)).toContain("Verify the chat")
    expect(JSON.stringify(requests[2]!.input)).toContain("chat-proof")
    expect(reopened.get(chat.id)?.messages.filter(item => item.role === "user")).toHaveLength(2)
})

test("conversations are isolated and active turns can be steered and stopped", async () => {
    const { cwd, authFile } = await fixture()
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const store = new ChatStore(new Database(":memory:"), cwd, {
        authFile,
        fetchImpl: async (_url, init) => {
            requestStarted()
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true })
            })
        },
    })
    stores.push(store)
    const one = await store.create()
    const two = await store.create()
    store.send(one.id, "Wait here")
    await started
    store.send(one.id, "Additional guidance")
    expect(store.get(one.id)?.messages.filter(message => message.role === "user")).toHaveLength(2)
    expect(store.get(two.id)?.messages).toHaveLength(0)
    expect(store.stop(one.id)).toBeTrue()
    await store.settled()
    expect(store.get(one.id)?.status).toBe("idle")
    expect(store.get(one.id)?.messages.at(-1)?.text).toBe("Stopped")
})

test("API rejects foreign origins, invalid bodies, and nonexistent chats", async () => {
    const { cwd } = await fixture()
    const store = new ChatStore(new Database(":memory:"), cwd)
    stores.push(store)
    const api = createChatApi(store)
    expect((await api(new Request("http://localhost/api/chats", { method: "POST", headers: { Origin: "https://foreign.example" } }))).status).toBe(403)
    expect((await api(new Request("http://rebound.example/api/chats"))).status).toBe(403)
    expect((await api(new Request("http://localhost/api/chats", { method: "POST", body: "{}" }))).status).toBe(415)
    expect((await api(new Request("http://localhost/api/chats/no-such-chat"))).status).toBe(404)
    expect((await api(new Request("http://localhost/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" }))).status).toBe(400)
    expect(store.list()).toEqual([])
})

test("SSE subscribers receive updates and can disconnect", async () => {
    const { cwd } = await fixture()
    const store = new ChatStore(new Database(":memory:"), cwd)
    stores.push(store)
    const api = createChatApi(store)
    const response = await api(new Request("http://localhost/api/events"))
    const reader = response.body!.getReader()
    await reader.read()
    const chat = await store.create()
    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain(chat.id)
    expect(chunk).not.toContain("context")
    await reader.cancel()
})

test("server restart marks incomplete turns as interrupted", async () => {
    const { cwd } = await fixture()
    const db = new Database(":memory:")
    db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, context TEXT)")
    db.query("INSERT INTO chats VALUES (?, ?, NULL)").run("interrupted", JSON.stringify({ id: "interrupted", title: "Test", cwd, model: "gpt-5.6-sol", status: "running", updatedAt: new Date().toISOString(), messages: [] }))
    const store = new ChatStore(db, cwd)
    stores.push(store)
    expect(store.get("interrupted")?.status).toBe("error")
    expect(store.get("interrupted")?.messages.at(-1)?.text).toContain("restarted")
})

test("imagegen flows through the agent, image API, chat preview and restart persistence", async () => {
    const { cwd, authFile } = await fixture()
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const database = join(cwd, "images.sqlite")
    let turns = 0
    const options = { authFile, fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/images/generations")) return Response.json({ data: [{ b64_json: png }] })
        const body = JSON.parse(String(init?.body))
        if (++turns === 1) {
            expect(body.tools.some((tool: JsonObject) => tool.name === "imagegen")).toBeTrue()
            return sse([{ type: "function_call", name: "imagegen", call_id: "draw-1", arguments: JSON.stringify({ prompt: "Draw a puppy" }) }])
        }
        const result = body.input.find((item: JsonObject) => item.type === "function_call_output" && item.call_id === "draw-1")
        expect(result.output[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "auto" })
        return sse([answer("Created.")])
    } }
    const store = new ChatStore(new Database(database), cwd, options)
    stores.push(store)
    const chat = await store.create()
    store.send(chat.id, "Draw a puppy")
    await store.settled()
    expect(store.get(chat.id)?.status).toBe("idle")
    const message = store.get(chat.id)!.messages.find(message => message.image)!
    expect(message.image?.prompt).toBe("Draw a puppy")
    const path = `/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`
    const api = createChatApi(store)
    const response = await api(new Request(`http://localhost${path}`))
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(png)
    const other = await store.create()
    expect((await api(new Request(`http://localhost/api/chats/${other.id}/images/${encodeURIComponent(message.id)}`))).status).toBe(404)
    expect((await api(new Request(`http://localhost${path}`, { headers: { Origin: "https://evil.test" } }))).status).toBe(403)
    stores.splice(stores.indexOf(store), 1)
    await store.close()
    const reopened = new ChatStore(new Database(database), cwd, options)
    stores.push(reopened)
    expect((await createChatApi(reopened)(new Request(`http://localhost${path}`))).status).toBe(200)
    reopened.send(chat.id, "What did you draw?")
    await reopened.settled()
    expect(reopened.get(chat.id)?.status).toBe("idle")
})

test("settings persist, drive new chat defaults and apply instructions to existing sessions", async () => {
    const { cwd, authFile } = await fixture()
    const database = join(cwd, "settings.sqlite")
    const requests: JsonObject[] = []
    const options = { authFile, fetchImpl: async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        return sse([answer("Ready")])
    } }
    const store = new ChatStore(new Database(database), cwd, options)
    stores.push(store)
    const old = await store.create()
    store.send(old.id, "Hello")
    await store.settled()
    const settings = { ...store.settings(), cwd: "/tmp", model: "gpt-5.6-terra", reasoningEffort: "high" as const, instructions: "Use short sentences.", enterToSend: false }
    const api = createChatApi(store)
    const saved = await api(new Request("http://localhost/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(settings)
    const created = await store.create()
    expect(created.cwd).toBe("/tmp")
    expect(created.model).toBe("gpt-5.6-terra")
    expect(store.get(old.id)?.cwd).toBe(cwd)
    expect(store.get(old.id)?.model).toBe("gpt-5.6-sol")
    store.send(old.id, "Continue")
    await store.settled()
    expect(requests[1]?.instructions).toContain("Use short sentences.")
    expect(requests[1]?.reasoning).toMatchObject({ effort: "high" })
    expect(requests[1]?.model).toBe("gpt-5.6-sol")
    const config = await (await api(new Request("http://localhost/api/config"))).json()
    expect(config.settings.enterToSend).toBeFalse()
    stores.splice(stores.indexOf(store), 1)
    await store.close()
    const reopened = new ChatStore(new Database(database), cwd, options)
    stores.push(reopened)
    expect(reopened.settings()).toEqual(settings)
})

test("invalid and cross-origin settings writes leave saved preferences intact", async () => {
    const { cwd } = await fixture()
    const store = new ChatStore(new Database(":memory:"), cwd)
    stores.push(store)
    const original = store.settings()
    const api = createChatApi(store)
    for (const patch of [{ cwd: "/nonexistent-puppygpt-settings-directory" }, { model: "bad" }, { reasoningEffort: "bad" }, { enterToSend: "false" }, { instructions: "x".repeat(16001) }, { surprise: true }]) {
        const response = await api(new Request("http://localhost/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...original, ...patch }) }))
        expect(response.status).toBe(400)
        expect(store.settings()).toEqual(original)
    }
    const foreign = await api(new Request("http://localhost/api/settings", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.test" }, body: JSON.stringify(original) }))
    expect(foreign.status).toBe(403)
    expect(store.settings()).toEqual(original)
})

test("chat execution target persists, restricts the agent, and can change only between turns", async () => {
    const { cwd, authFile } = await fixture()
    const path = join(cwd, "target-chats.sqlite")
    const executionPolicy = { defaultTarget: "docker", targets: [{ id: "host", kind: "host" as const }, { id: "docker", kind: "docker" as const, image: "test:local", workspaceRoot: cwd }] }
    const exposed: string[][] = []
    const store = new ChatStore(new Database(path), cwd, { authFile, executionPolicy, fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        exposed.push(body.tools[0].parameters.properties.target.enum)
        return sse([answer("Done")])
    } }); stores.push(store)
    const api = createChatApi(store)
    const post = (url: string, body: unknown) => api(new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
    const created = await (await post("/api/chats", { executionTarget: "host" })).json()
    expect(created.executionTarget).toBe("host")
    store.send(created.id, "Hello")
    expect(() => store.setExecutionTarget(created.id, "docker")).toThrow("current turn")
    await store.settled()
    expect(exposed).toEqual([["host"]])
    const changed = await post(`/api/chats/${created.id}/execution-target`, { target: "docker" })
    expect(changed.status).toBe(200)
    store.send(created.id, "Again")
    await store.settled()
    expect(exposed).toEqual([["host"], ["docker"]])
    expect((await post(`/api/chats/${created.id}/execution-target`, { target: "unknown" })).status).toBe(400)
    expect(store.get(created.id)?.executionTarget).toBe("docker")
    expect((await post("/api/chats", { executionTarget: "unknown" })).status).toBe(400)
    expect((await store.create()).executionTarget).toBe("docker")
    const config = await store.config()
    expect(config.execution.targets).toEqual([{ id: "host", kind: "host" }, { id: "docker", kind: "docker" }])
    await store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = new ChatStore(new Database(path), cwd, { executionPolicy }); stores.push(reopened)
    expect(reopened.get(created.id)?.executionTarget).toBe("docker")
})

test("two chats can reference one independent environment through the API", async () => {
 const {cwd}=await fixture();const store=new ChatStore(new Database(":memory:"),cwd);stores.push(store)
 const api=createChatApi(store)
 const post=(path:string,body:unknown)=>api(new Request(`http://localhost${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}))
 const env=await (await post("/api/environments",{name:"Shared host",targetId:"host"})).json()
 const a=await (await post("/api/chats",{environmentId:env.id})).json(),b=await (await post("/api/chats",{environmentId:env.id})).json()
 expect(a.environmentId).toBe(env.id);expect(b.environmentId).toBe(env.id)
 await post(`/api/chats/${a.id}/environment`,{environmentId:"default-host"})
 expect(store.environments.get(env.id)?.name).toBe("Shared host")
 expect(store.get(b.id)?.environmentId).toBe(env.id)
 expect((await post(`/api/chats/${b.id}/environment`,{environmentId:"missing"})).status).toBe(400)
})

test("environment shell streams real command output and enforces the API boundary", async () => {
    const { cwd, authFile } = await fixture()
    const store = new ChatStore(new Database(":memory:"), cwd, { authFile })
    stores.push(store)
    const api = createChatApi(store)
    const request = (command: unknown, id = "default-host", origin = "http://localhost") => new Request(`http://localhost/api/environments/${id}/shell`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ command }) })
    expect((await api(request("pwd", "default-host", "https://example.com"))).status).toBe(403)
    expect((await api(request(""))).status).toBe(400)
    expect((await api(request("pwd", "missing"))).status).toBe(400)
    const response = await api(request("pwd; printf shell-ok; printf shell-error >&2; exit 7"))
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson")
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line))
    expect(events.filter(event => event.type === "output").map(event => event.text).join("")).toContain(cwd)
    expect(events.filter(event => event.stream === "stdout").map(event => event.text).join("")).toContain("shell-ok")
    expect(events.filter(event => event.stream === "stderr").map(event => event.text).join("")).toContain("shell-error")
    expect(events.at(-1)).toMatchObject({ type: "done", exitCode: 7, timedOut: false })
})

test("disconnecting an environment shell cancels its running command", async () => {
    const { cwd, authFile } = await fixture()
    const store = new ChatStore(new Database(":memory:"), cwd, { authFile })
    stores.push(store)
    const abort = new AbortController()
    const response = await createChatApi(store)(new Request("http://localhost/api/environments/default-host/shell", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "printf started; sleep 30; touch should-not-exist" }), signal: abort.signal }))
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("started")
    abort.abort()
    while (!(await reader.read()).done) {}
    expect(await Bun.file(join(cwd, "should-not-exist")).exists()).toBeFalse()
}, 5000)
