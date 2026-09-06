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
    expect(store.get(old.id)?.model).toBe("gpt-6-astra")
    store.send(old.id, "Continue")
    await store.settled()
    expect(requests[1]?.instructions).toContain("Use short sentences.")
    expect(requests[1]?.reasoning).toMatchObject({ effort: "high" })
    expect(requests[1]?.model).toBe("gpt-6-astra")
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
    const created = await (await post("/api/chats", { environmentId: "default-host" })).json()
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

test("new Docker chats start unique containers and reuse them across turns and server restarts", async () => {
    const { cwd, authFile } = await fixture()
    const path = join(cwd, "owned.sqlite")
    const executionPolicy = { defaultTarget: "docker", targets: [{ id: "docker", kind: "docker" as const, image: "test:local", workspaceRoot: cwd }] }
    const containers = new Map<string, { owner: string, running: boolean }>()
    let creates = 0
    const control = async (_socket: string, args: string[]) => {
        if (args[0] === "create") {
            const id = args[args.indexOf("--name") + 1]!
            containers.set(id, { owner: args[args.indexOf("--label") + 1]!.split("=")[1]!, running: false })
            creates++
            return id
        }
        const container = containers.get(args.at(-1)!)
        if (args[0] === "inspect") return JSON.stringify({ Config: { Labels: { "puppygpt.environment": container!.owner } }, State: { Running: container!.running } })
        if (args[0] === "start") container!.running = true
        if (args[0] === "stop") container!.running = false
        return ""
    }
    const options = { authFile, executionPolicy, fetchImpl: async () => sse([answer("Done")]) }
    let store = new ChatStore(new Database(path), cwd, options, undefined, control)
    stores.push(store)
    const a = await store.create(), b = await store.create()
    expect(a.environmentId).not.toBe(b.environmentId)
    expect(store.environments.get(a.environmentId!)?.ownerChatId).toBe(a.id)
    store.send(a.id, "First"); await store.settled()
    expect(store.get(a.id)?.status).toBe("idle")
    const handle = store.environments.get(a.environmentId!)?.handle
    expect(handle).toBeDefined()
    store.send(a.id, "Second"); await store.settled()
    expect(creates).toBe(1)
    store.send(b.id, "Other chat"); await store.settled()
    expect(creates).toBe(2)
    expect(() => store.setEnvironment(a.id, b.environmentId!)).toThrow("keeps its own")
    await store.environments.action(a.environmentId!, "stop")
    await store.close(); stores.splice(stores.indexOf(store), 1)
    store = new ChatStore(new Database(path), cwd, options, undefined, control); stores.push(store)
    store.send(a.id, "After restart"); await store.settled()
    expect(store.environments.get(a.environmentId!)?.handle).toEqual(handle)
    expect(store.environments.get(a.environmentId!)?.status).toBe("ready")
    expect(creates).toBe(2)
})

test("Docker startup failure stays attached to the chat and never falls back to host", async () => {
    const { cwd, authFile } = await fixture()
    let requests = 0
    const store = new ChatStore(new Database(":memory:"), cwd, { authFile, executionPolicy: { defaultTarget: "docker", targets: [{ id: "docker", kind: "docker", image: "missing:local", workspaceRoot: cwd }] }, fetchImpl: async () => { requests++; return sse([answer("Wrong")]) } }, undefined, async () => { throw new Error("Docker unavailable") })
    stores.push(store)
    const chat = await store.create()
    store.send(chat.id, "Hello"); await store.settled()
    expect(store.get(chat.id)?.status).toBe("error")
    expect(store.get(chat.id)?.environmentId).toBe(chat.environmentId)
    expect(store.get(chat.id)?.messages.at(-1)?.text).toContain("Docker unavailable")
    expect(requests).toBe(0)
})

test("model switching persists and uses the new model with prior context", async () => {
    const { cwd, authFile } = await fixture()
    const database = join(cwd, "models.sqlite")
    const requests: JsonObject[] = []
    const options = { authFile, fetchImpl: async (_url: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        return sse([answer("Remember the blue puppy")])
    } }
    const store = new ChatStore(new Database(database), cwd, options); stores.push(store)
    const chat = await store.create()
    expect(chat.model).toBe("gpt-6-astra")
    store.send(chat.id, "Remember our puppy")
    expect(() => store.setModel(chat.id, "gpt-5.6-sol")).toThrow("current turn")
    await store.settled()
    const api = createChatApi(store)
    const change = (model: unknown) => api(new Request(`http://localhost/api/chats/${chat.id}/model`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) }))
    expect((await change("unknown")).status).toBe(400)
    expect((await change(42)).status).toBe(400)
    expect((await change("gpt-5.6-sol")).status).toBe(200)
    store.send(chat.id, "What color?"); await store.settled()
    expect(requests[1]!.model).toBe("gpt-5.6-sol")
    expect(JSON.stringify(requests[1]!.input)).toContain("blue puppy")
    stores.splice(stores.indexOf(store), 1); await store.close()
    const reopened = new ChatStore(new Database(database), cwd, options); stores.push(reopened)
    expect(reopened.get(chat.id)?.model).toBe("gpt-5.6-sol")
    expect(reopened.get(chat.id)?.environmentId).toBe(chat.environmentId)
    expect(reopened.get(chat.id)?.messages.filter(m => m.role === "user")).toHaveLength(2)
})

test("backend search finds titles and message text, treats wildcards literally, and survives reload", async () => {
    const { cwd } = await fixture()
    const database = join(cwd, "search.sqlite")
    const db = new Database(database)
    const store = new ChatStore(db, cwd); stores.push(store)
    const first = await store.create(), second = await store.create()
    first.title = "Garden notes"
    first.messages = [{ id: "m1", role: "assistant", text: "The hidden lavender grows 100%_well" }]
    first.updatedAt = "2026-09-01T00:00:00.000Z"
    second.title = "Lavender plans"
    second.updatedAt = "2026-09-02T00:00:00.000Z"
    for (const { messages, ...chat } of [first, second]) {
        db.query("UPDATE chats SET data=? WHERE id=?").run(JSON.stringify(chat), chat.id)
        for (const [position, message] of messages.entries()) db.query("INSERT INTO messages (chat_id, id, position, role, text) VALUES (?, ?, ?, ?, ?)").run(chat.id, message.id, position, message.role, message.text)
    }
    const api = createChatApi(store)
    const search = async (q: string) => api(new Request(`http://localhost/api/chats?q=${encodeURIComponent(q)}`))
    const matches = await (await search(" LAVENDER ")).json()
    expect(matches.map((c: any) => c.id)).toEqual([second.id, first.id])
    expect(matches.every((c: any) => !("messages" in c) && !("context" in c))).toBeTrue()
    expect((await (await search("100%_")).json()).map((c: any) => c.id)).toEqual([first.id])
    expect(await (await search("' OR 1=1 --")).json()).toEqual([])
    expect(await (await search("missing")).json()).toEqual([])
    expect(await (await search(" ")).json()).toHaveLength(2)
    expect((await search("a".repeat(501))).status).toBe(400)
    store.setModel(first.id, "gpt-5.6-sol")
    store.get(first.id)!.messages.push({ id: "live", role: "assistant", text: "streaming-only-term" })
    expect(store.search("streaming-only-term").map(c => c.id)).toEqual([first.id])
    stores.splice(stores.indexOf(store), 1); await store.close()
    const reopened = new ChatStore(new Database(database), cwd); stores.push(reopened)
    expect(reopened.search("hidden lavender").map(c => c.id)).toEqual([first.id])
})

test("completion attention persists until explicitly viewed and stale acknowledgements cannot clear a newer turn", async () => {
    const { cwd, authFile } = await fixture()
    const database = join(cwd, "attention.sqlite")
    const options = { authFile, fetchImpl: async () => sse([answer("Done")]) }
    const store = new ChatStore(new Database(database), cwd, options); stores.push(store)
    const chat = await store.create()
    expect(chat.attentionId).toBeUndefined()
    store.send(chat.id, "First"); await store.settled()
    const first = store.get(chat.id)!.attentionId!
    expect(first).toBeString()
    expect(store.list()[0]!.attentionId).toBe(first)
    expect(store.search("Done")[0]!.attentionId).toBe(first)
    const api = createChatApi(store)
    await api(new Request(`http://localhost/api/chats/${chat.id}`))
    expect(store.get(chat.id)!.attentionId).toBe(first)
    store.send(chat.id, "Second")
    store.markViewed(chat.id, first)
    expect(store.get(chat.id)!.attentionId).toBe(first)
    await store.settled()
    const second = store.get(chat.id)!.attentionId!
    expect(second).not.toBe(first)
    store.markViewed(chat.id, first)
    expect(store.get(chat.id)!.attentionId).toBe(second)
    stores.splice(stores.indexOf(store), 1); await store.close()
    const reopened = new ChatStore(new Database(database), cwd, options); stores.push(reopened)
    expect(reopened.get(chat.id)!.attentionId).toBe(second)
    const timestamp = reopened.get(chat.id)!.updatedAt
    const response = await createChatApi(reopened)(new Request(`http://localhost/api/chats/${chat.id}/viewed`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({attentionId:second})}))
    expect(response.status).toBe(200)
    expect(reopened.get(chat.id)!.attentionId).toBeUndefined()
    expect(reopened.get(chat.id)!.updatedAt).toBe(timestamp)
    stores.splice(stores.indexOf(reopened), 1); await reopened.close()
    const final = new ChatStore(new Database(database), cwd, options); stores.push(final)
    expect(final.get(chat.id)!.attentionId).toBeUndefined()
})

test("custom GPTs persist and configure new chats without changing existing agent snapshots", async () => {
    const { cwd, authFile } = await fixture()
    const database = join(cwd, "gpts.sqlite")
    const requests: JsonObject[] = []
    const options = { authFile, fetchImpl: async (_url: unknown, init?: RequestInit) => { requests.push(JSON.parse(String(init?.body))); return sse([answer("Reviewed")]) } }
    const store = new ChatStore(new Database(database), cwd, options); stores.push(store)
    const api = createChatApi(store)
    const post = (path: string, body: unknown) => api(new Request(`http://localhost${path}`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}))
    const input = {name:"Reviewer",description:"Reviews changes",instructions:"Always look for missing edge cases.",model:"gpt-5.6-terra",reasoningEffort:"high"}
    expect((await post("/api/gpts", {...input, name:""})).status).toBe(400)
    expect((await post("/api/gpts", {...input, model:"unknown"})).status).toBe(400)
    const created = await post("/api/gpts", input); expect(created.status).toBe(201)
    const gpt = await created.json()
    const response = await post("/api/chats", {gptId:gpt.id}); expect(response.status).toBe(201)
    const chat = await response.json()
    expect(chat.model).toBe(input.model); expect(chat.gpt.instructions).toBe(input.instructions)
    expect(store.list()[0]!.gptName).toBe("Reviewer"); expect(store.list()[0]).not.toHaveProperty("gpt")
    await post(`/api/gpts/${gpt.id}`, {...input, instructions:"New instructions",model:"gpt-6-astra"})
    const next = await (await post("/api/chats",{gptId:gpt.id})).json()
    expect(next.gpt.instructions).toBe("New instructions"); expect(next.model).toBe("gpt-6-astra")
    stores.splice(stores.indexOf(store),1); await store.close()
    const reopened = new ChatStore(new Database(database),cwd,options); stores.push(reopened)
    expect(reopened.gpts.list()).toHaveLength(1)
    reopened.gpts.delete(gpt.id)
    reopened.send(chat.id,"Review this"); await reopened.settled()
    expect(requests[0]!.model).toBe(input.model)
    expect(JSON.stringify(requests[0])).toContain(input.instructions)
    expect(JSON.stringify(requests[0])).not.toContain("New instructions")
    expect(requests[0]!.reasoning).toMatchObject({effort:"high"})
    expect(reopened.get(chat.id)!.status).toBe("idle")
    expect(reopened.gpts.list()).toHaveLength(0)
    await expect(reopened.create(undefined,undefined,undefined,undefined,gpt.id)).rejects.toThrow("GPT not found")
})

test("legacy messages migrate atomically with order, optional fields and context intact", async () => {
    const { cwd } = await fixture()
    const path = join(cwd, "migration.sqlite")
    const db = new Database(path)
    db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, context TEXT)")
    const messages: import("./chat-types").ChatMessage[] = [
        { id: "z", role: "user", text: "First" },
        { id: "a", role: "activity", text: "Command", detail: "Output", running: false },
        { id: "b", role: "assistant", text: "", image: { path: "/tmp/image.png", prompt: "Puppy" } },
    ]
    const context = JSON.stringify({ input: [{ role: "user", content: "First" }] })
    for (const id of ["one", "two"]) db.query("INSERT INTO chats VALUES (?, ?, ?)").run(id, JSON.stringify({ id, title: id, cwd, model: "gpt-5.6-sol", status: "idle", updatedAt: "2026-09-06", messages }), context)
    const store = new ChatStore(db, cwd); stores.push(store)
    expect(store.get("one")?.messages).toMatchObject(messages)
    expect(store.get("two")?.messages).toMatchObject(messages)
    const row = db.query<{ data: string, context: string }, []>("SELECT data, context FROM chats WHERE id = 'one'").get()!
    expect(JSON.parse(row.data).messages).toBeUndefined()
    expect(row.context).toBe(context)
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(6)
    stores.splice(stores.indexOf(store), 1); await store.close()
    const reopenedDb = new Database(path)
    const reopened = new ChatStore(reopenedDb, cwd); stores.push(reopened)
    expect(reopened.get("one")?.messages).toMatchObject(messages)
    expect(reopenedDb.query("SELECT * FROM messages").all()).toHaveLength(6)
    reopenedDb.query("DELETE FROM chats WHERE id = 'one'").run()
    expect(reopenedDb.query("SELECT * FROM messages WHERE chat_id = 'one'").all()).toHaveLength(0)
    expect(reopened.get("two")?.messages).toMatchObject(messages)
})

test("streamed text is durable before completion and does not rewrite previous messages", async () => {
    const { cwd, authFile } = await fixture()
    const db = new Database(join(cwd, "stream.sqlite"))
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const store = new ChatStore(db, cwd, { authFile, fetchImpl: async () => new Response(stream) }); stores.push(store)
    const chat = await store.create()
    db.run("CREATE TABLE message_updates (id TEXT)")
    db.run("CREATE TRIGGER record_message_update AFTER UPDATE ON messages BEGIN INSERT INTO message_updates VALUES (NEW.id); END")
    store.send(chat.id, "Hello")
    const emit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    emit({ type: "response.output_text.delta", delta: "Partial response" })
    try {
        for (let attempt = 0; attempt < 200; attempt++) {
            if (db.query("SELECT id FROM messages WHERE role = 'assistant'").get()) break
            await Bun.sleep(5)
        }
        expect(db.query("SELECT text FROM messages WHERE role = 'assistant'").get()).toEqual({ text: "Partial response" })
        expect(db.query("SELECT id FROM message_updates").all()).toEqual([])
        expect(JSON.parse((db.query("SELECT data FROM chats").get() as { data: string }).data).messages).toBeUndefined()
    } finally {
        emit({ type: "response.completed", response: { output: [answer("Partial response completed")] } })
        controller.close()
        await store.settled()
    }
    expect(db.query("SELECT text FROM messages WHERE role = 'assistant'").get()).toEqual({ text: "Partial response completed" })
    expect(db.query("SELECT id FROM message_updates WHERE id = ?").all(store.get(chat.id)!.messages[0]!.id)).toEqual([])
})

test("failed message migration rolls back all chats", async () => {
    const { cwd } = await fixture()
    const db = new Database(":memory:")
    try {
        db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, data TEXT NOT NULL, context TEXT)")
        const original = JSON.stringify({ id: "valid", messages: [{ id: "m", role: "user", text: "Keep me" }] })
        db.query("INSERT INTO chats VALUES (?, ?, NULL)").run("valid", original)
        db.query("INSERT INTO chats VALUES (?, ?, NULL)").run("invalid", JSON.stringify({ id: "invalid", messages: [{ id: "m", role: "unknown", text: "Invalid role" }] }))
        expect(() => new ChatStore(db, cwd)).toThrow()
        expect(db.query("SELECT data FROM chats WHERE id = 'valid'").get()).toEqual({ data: original })
        expect(db.query("SELECT name FROM sqlite_master WHERE name = 'messages'").get()).toBeNull()
    } finally { db.close() }
})

test("forks share message rows, retain historical tool context and isolate later branches across restart", async () => {
    const { cwd, authFile } = await fixture()
    const path = join(cwd, "forks.sqlite")
    const db = new Database(path)
    const inputs: string[] = []
    const sessions: string[] = []
    const options = { authFile, fetchImpl: async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        inputs.push(JSON.stringify(body.input))
        sessions.push(new Headers(init?.headers).get("session-id")!)
        if (inputs.length === 1) return sse([{ type: "function_call", name: "exec", call_id: "proof", arguments: JSON.stringify({ command: "printf historical-tool-proof", timeout_ms: 1000 }) }])
        return sse([answer(`Answer ${inputs.length}`)])
    } }
    const store = new ChatStore(db, cwd, options); stores.push(store)
    const original = await store.create()
    store.send(original.id, "Initial question")
    await store.settled()
    const first = store.get(original.id)!
    const point = first.messages.at(-1)!
    expect(point.forkContext).toBe("exact")
    store.send(original.id, "FUTURE-SOURCE-ONLY")
    await store.settled()
    const api = createChatApi(store)
    const forkResponse = await api(new Request(`http://localhost/api/chats/${original.id}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId: point.id }) }))
    expect(forkResponse.status).toBe(201)
    const fork: import("./chat-types").Chat = await forkResponse.json()
    expect(fork.parentChatId).toBe(original.id)
    expect(fork.forkContext).toBe("exact")
    expect(fork.messages.at(-1)?.id).toBe(point.id)
    expect(db.query("SELECT * FROM messages WHERE chat_id = ?").all(fork.id)).toHaveLength(0)
    store.send(fork.id, "BRANCH-ONLY")
    await store.settled()
    expect(inputs.at(-1)).toContain("historical-tool-proof")
    expect(inputs.at(-1)).toContain("Initial question")
    expect(inputs.at(-1)).not.toContain("FUTURE-SOURCE-ONLY")
    expect(sessions.at(-1)).not.toBe(sessions[0])
    expect(store.get(original.id)?.messages.some(message => message.text === "BRANCH-ONLY")).toBeFalse()
    const branchUser = store.get(fork.id)!.messages.find(message => message.text === "BRANCH-ONLY")!
    expect(branchUser.parentMessageId).toBe(point.id)
    expect(branchUser.parentChatId).toBe(original.id)
    expect(db.query("SELECT * FROM messages WHERE chat_id = ?").all(fork.id)).toHaveLength(2)
    const nested = await store.fork(fork.id, branchUser.id)
    store.send(nested.id, "NESTED-ONLY")
    await store.settled()
    expect(inputs.at(-1)).toContain("BRANCH-ONLY")
    expect(inputs.at(-1)).not.toContain("Answer 4")
    expect(store.search("Initial question").map(chat => chat.id)).toEqual(expect.arrayContaining([original.id, fork.id, nested.id]))
    expect(store.search("FUTURE-SOURCE-ONLY").map(chat => chat.id)).toEqual([original.id])
    stores.splice(stores.indexOf(store), 1); await store.close()
    const reopened = new ChatStore(new Database(path), cwd, options); stores.push(reopened)
    expect(reopened.get(fork.id)?.messages.at(-1)?.text).toBe("Answer 4")
    expect(reopened.get(nested.id)?.messages.some(message => message.text === "FUTURE-SOURCE-ONLY")).toBeFalse()
    reopened.send(fork.id, "Continue fork after restart")
    await reopened.settled()
    expect(inputs.at(-1)).toContain("historical-tool-proof")
    expect(inputs.at(-1)).not.toContain("FUTURE-SOURCE-ONLY")
})

test("inline questions validate exact source selection and legacy forks use only the visible prefix", async () => {
    const { cwd, authFile } = await fixture()
    const db = new Database(":memory:")
    let input = ""
    const store = new ChatStore(db, cwd, { authFile, fetchImpl: async (_url, init) => { input = JSON.stringify(JSON.parse(String(init?.body)).input); return sse([answer("Explained")]) } }); stores.push(store)
    const chat = await store.create()
    db.query("INSERT INTO messages (chat_id, id, position, role, text) VALUES (?, 'legacy', 0, 'assistant', 'Alpha beta gamma')").run(chat.id)
    db.query("INSERT INTO messages (chat_id, id, position, role, text) VALUES (?, 'future', 1, 'user', 'FUTURE')").run(chat.id)
    const api = createChatApi(store)
    const post = (body: unknown) => api(new Request(`http://localhost/api/chats/${chat.id}/fork`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
    expect((await post({ messageId: "legacy", selection: { text: "wrong", start: 6, end: 10 } })).status).toBe(400)
    expect((await post({ messageId: "missing" })).status).toBe(400)
    expect((await post({ messageId: "legacy", environmentId: "missing" })).status).toBe(400)
    expect(store.list()).toHaveLength(1)
    const response = await post({ messageId: "legacy", prompt: "Why this word?", selection: { text: "beta", start: 6, end: 10 } })
    expect(response.status).toBe(201)
    const fork = await response.json()
    await store.settled()
    expect(store.get(fork.id)?.messages.find(message => message.sourceChatId === fork.id && message.role === "user")?.text).toBe("Why this word?")
    expect(fork.selection).toEqual({ text: "beta", start: 6, end: 10 })
    expect(fork.forkContext).toBe("transcript")
    expect(input).toContain("Alpha beta gamma")
    expect(input).toContain("<selected_passage>\\nbeta")
    expect(input).toContain("Why this word?")
    expect(input).not.toContain("FUTURE")
})

test("chat download returns an attachment and rejects unknown chats", async () => {
    const { cwd } = await fixture()
    const store = new ChatStore(new Database(":memory:"), cwd); stores.push(store)
    const chat = await store.create()
    const api = createChatApi(store)
    const response = await api(new Request(`http://localhost/api/chats/${chat.id}/download`))
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="New-chat.md"')
    expect(response.headers.get("Content-Type")).toContain("text/markdown")
    expect(await response.text()).toContain("# New chat")
    expect((await api(new Request("http://localhost/api/chats/missing/download"))).status).toBe(404)
})

test("forking rejects active sources and cross-origin requests without creating a branch", async () => {
    const { cwd, authFile } = await fixture()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const store = new ChatStore(new Database(":memory:"), cwd, { authFile, fetchImpl: async (_url, init) => {
        started()
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }))
    } }); stores.push(store)
    const chat = await store.create()
    store.send(chat.id, "Wait")
    await ready
    const messageId = store.get(chat.id)!.messages[0]!.id
    await expect(store.fork(chat.id, messageId)).rejects.toThrow("finish")
    const response = await createChatApi(store)(new Request(`http://localhost/api/chats/${chat.id}/fork`, { method: "POST", headers: { Origin: "https://foreign.test", "Content-Type": "application/json" }, body: JSON.stringify({ messageId }) }))
    expect(response.status).toBe(403)
    expect(store.list()).toHaveLength(1)
    store.stop(chat.id); await store.settled()
})

test("manual compaction makes one request, preserves the transcript and restores compacted context after restart", async () => {
    const { cwd, authFile } = await fixture()
    const path = join(cwd, "manual-compaction.sqlite")
    const requests: JsonObject[] = []
    const options = { authFile, fetchImpl: async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)); requests.push(body)
        if (body.input.at(-1)?.type === "compaction_trigger") return sse([{ type: "compaction", encrypted_content: "manual-checkpoint" }])
        return sse([answer("Original answer")])
    } }
    const store = new ChatStore(new Database(path), cwd, options); stores.push(store)
    const chat = await store.create()
    expect(() => store.compact(chat.id)).toThrow("no agent context")
    store.send(chat.id, "Original question"); await store.settled()
    const before = structuredClone(store.get(chat.id)!.messages)
    const api = createChatApi(store)
    const response = await api(new Request(`http://localhost/api/chats/${chat.id}/compact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(response.status).toBe(202)
    expect(() => store.compact(chat.id)).toThrow("finish")
    expect(() => store.send(chat.id, "Not while compacting")).toThrow("compaction")
    await store.settled()
    expect(requests).toHaveLength(2)
    expect((requests[1]!.input as JsonObject[]).at(-1)?.type).toBe("compaction_trigger")
    expect(store.get(chat.id)!.messages.slice(0, before.length)).toEqual(before)
    expect(store.get(chat.id)!.messages.at(-1)?.text).toBe("Conversation compacted")
    expect(store.get(chat.id)!.status).toBe("idle")
    stores.splice(stores.indexOf(store), 1); await store.close()
    const reopened = new ChatStore(new Database(path), cwd, options); stores.push(reopened)
    expect(reopened.get(chat.id)!.messages.at(-1)?.text).toBe("Conversation compacted")
    reopened.send(chat.id, "Continue"); await reopened.settled()
    expect(JSON.stringify(requests.at(-1)?.input)).toContain("manual-checkpoint")
    expect((requests.at(-1)!.input as JsonObject[]).some(item => item.role === "assistant")).toBeFalse()
})

test("failed or cancelled manual compaction preserves previous context", async () => {
    const { cwd, authFile } = await fixture()
    const db = new Database(":memory:")
    let cancel = false
    let requestStarted!: () => void
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const store = new ChatStore(db, cwd, { authFile, maxRetries: 0, fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.input.at(-1)?.type === "compaction_trigger") {
            if (!cancel) return sse([answer("Invalid compaction response")])
            requestStarted()
            return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }))
        }
        return sse([answer("Keep this answer")])
    } }); stores.push(store)
    const chat = await store.create()
    store.send(chat.id, "Keep this question"); await store.settled()
    const readItems = () => JSON.parse((db.query("SELECT context FROM chats WHERE id = ?").get(chat.id) as { context: string }).context).items
    const before = readItems()
    store.compact(chat.id); await store.settled()
    expect(readItems()).toEqual(before)
    expect(store.get(chat.id)!.messages.some(message => message.text === "Compaction failed")).toBeTrue()
    cancel = true
    store.compact(chat.id); await started
    expect(store.stop(chat.id)).toBeTrue()
    await store.settled()
    expect(readItems()).toEqual(before)
    expect(store.get(chat.id)!.status).toBe("idle")
    expect(store.get(chat.id)!.messages.some(message => message.running)).toBeFalse()
    const rejected = await createChatApi(store)(new Request(`http://localhost/api/chats/${chat.id}/compact`, { method: "POST", headers: { Origin: "https://foreign.test", "Content-Type": "application/json" }, body: "{}" }))
    expect(rejected.status).toBe(403)
})

test("context API exposes retained model input and effective instructions without auth configuration", async () => {
    const { cwd, authFile } = await fixture()
    const database = join(cwd,"context-view.sqlite")
    await Bun.write(join(cwd,"AGENTS.md"),"Workspace context rule")
    const store = new ChatStore(new Database(database),cwd,{authFile,fetchImpl:async()=>sse([answer("Context answer")])}); stores.push(store)
    const chat = await store.create()
    expect((await store.context(chat.id)).source).toBe("empty")
    store.send(chat.id,"Context question"); await store.settled()
    const live = await store.context(chat.id)
    expect(live.source).toBe("live")
    expect(JSON.stringify(live.snapshot?.items)).toContain("Context question")
    expect(JSON.stringify(live.snapshot?.items)).toContain("Context answer")
    expect(live.instructions).toContain("Workspace context rule")
    expect(live.tools.length).toBeGreaterThan(0)
    expect(JSON.stringify(live)).not.toContain(authFile)
    stores.splice(stores.indexOf(store),1); await store.close()
    const reopened = new ChatStore(new Database(database),cwd); stores.push(reopened)
    const api = createChatApi(reopened)
    const response = await api(new Request(`http://localhost/api/chats/${chat.id}/context`))
    expect(response.status).toBe(200)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    const saved = await response.json()
    expect(saved.source).toBe("saved")
    expect(saved.snapshot.items).toEqual(live.snapshot!.items)
    expect((await api(new Request("http://localhost/api/chats/missing/context"))).status).toBe(404)
})
