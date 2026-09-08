import { afterEach, expect, test } from "bun:test"
import { VoiceStore, type VoiceSocket } from "./voice"
import { VOICE_CALL_URL, voiceCallId, voiceTextChunks } from "./voice-protocol"
import type { FetchLike } from "./agent/types"

class Socket extends EventTarget implements VoiceSocket {
    readyState: 0 | 1 | 2 | 3 = 0
    sent: any[] = []
    constructor() { super(); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")) }, 0) }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) { this.sent.push(JSON.parse(String(data))) }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")) }
    event(data: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })) }
}
const stores: VoiceStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.close()) })
const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
function fixture(options: { fetchImpl?: FetchLike, consult?: (id: string, prompt: string) => Promise<string> } = {}) {
    let socket: Socket
    const requests: { url: string, init: RequestInit }[] = []
    const transcripts: unknown[] = []
    const consulted: string[] = []
    const raw = { auth_mode: "chatgpt", tokens: { access_token: `a.${Buffer.from(JSON.stringify({ exp: 4_000_000_000 })).toString("base64url")}.s`, refresh_token: "secret-refresh", account_id: "account-test" } }
    const storage = { key: {}, read: async () => raw, write: async (value: any) => { Object.assign(raw, value) } }
    let refreshes = 0
    const store = new VoiceStore({
        auth: () => ({ authStorage: storage, fetchImpl: async () => { refreshes++; return Response.json({ access_token: raw.tokens.access_token + "refreshed", refresh_token: "next-refresh" }) } }),
        history: () => [{ role: "user", text: "Hello" }],
        transcript: (...args) => { transcripts.push(args) },
        consult: options.consult ?? (async (_id, prompt) => { consulted.push(prompt); return "Task completed " + "你".repeat(400) }),
    }, { fetchImpl: options.fetchImpl ?? (async (url: any, init: any) => { requests.push({ url: String(url), init }); return new Response(sdp, { headers: { "openai-session-id": "rtc_test" } }) }) as FetchLike,
        socket: (url, headers) => { expect(url).toBe("wss://api.openai.com/v1/live/rtc_test"); expect(headers["chatgpt-account-id"]).toBe("account-test"); socket = new Socket(); return socket },
    })
    stores.push(store)
    return { store, requests, transcripts, consulted, socket: () => socket!, refreshes: () => refreshes }
}
const start = (store: VoiceStore, signal = new AbortController().signal) => store.start("chat", crypto.randomUUID(), sdp, "cove", signal)
const delegation = (id = "d1", prompt = "inspect workspace") => ({ type: "delegation.created", item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text: prompt }] } })

test("OAuth call uses Codex JSON and server-owned headers; response contains no credentials", async () => {
    const f = fixture()
    const result = await start(f.store)
    expect(f.requests[0]!.url).toBe(VOICE_CALL_URL)
    const request = f.requests[0]!.init
    expect(request.redirect).toBe("error")
    expect(new Headers(request.headers).get("OpenAI-Alpha")).toBe("quicksilver=v2")
    expect(JSON.parse(String(request.body))).toMatchObject({ session: { model: "gpt-live-1-codex", audio: { output: { voice: "cove" } }, delegation: { type: "client" } } })
    expect(JSON.stringify(result)).not.toContain("token")
    expect(f.store.get("chat", result.id).status).toBe("connected")
    expect(() => f.store.get("other", result.id)).toThrow("not found")
    await expect(start(f.store)).rejects.toThrow("existing voice")
    f.store.stop("chat", result.id)
    expect(f.socket().sent).toContainEqual({ type: "session.close" })
    expect(f.socket().readyState).toBe(3)
})

test("provider transcripts persist once and duplicate delegations execute once", async () => {
    const f = fixture()
    await start(f.store)
    const turn = { type: "turn.done", event_id: "t1", turn: { role: "user", transcript: "Hello voice" } }
    f.socket().event(turn); f.socket().event(turn)
    expect(f.transcripts).toEqual([["chat", "user", "Hello voice"]])
    f.socket().event(delegation()); f.socket().event(delegation())
    await Bun.sleep(5)
    expect(f.consulted).toHaveLength(1)
    expect(f.consulted[0]).toStartWith("inspect workspace")
    expect(f.consulted[0]).toContain("Hello voice")
    expect(f.socket().sent.length).toBeGreaterThan(1)
    for (const event of f.socket().sent) {
        expect(event.type).toBe("delegation.context.append")
        expect(event.delegation_item_id).toBe("d1")
        expect(Buffer.byteLength(event.content[0].text)).toBeLessThanOrEqual(500)
    }
})

test("ending voice suppresses late agent replies and allows a replacement call", async () => {
    let finish!: (value: string) => void
    const f = fixture({ consult: () => new Promise(resolve => { finish = resolve }) })
    const result = await start(f.store)
    f.socket().event(delegation())
    f.socket().event(delegation("d2"))
    expect(f.socket().sent[0].content[0].text).toContain("still running")
    f.store.stop("chat", result.id)
    const old = f.socket()
    finish("Late result")
    await Bun.sleep(5)
    expect(JSON.stringify(old.sent)).not.toContain("Late result")
    await start(f.store)
})

test("rejects invalid media, voices, and inaccessible calls before delegation", async () => {
    const f = fixture()
    await expect(f.store.start("chat", crypto.randomUUID(), sdp + "m=video 9 RTP/AVP 96\r\n", "cove", new AbortController().signal)).rejects.toThrow("audio-only")
    await expect(f.store.start("chat", crypto.randomUUID(), sdp, "made-up", new AbortController().signal)).rejects.toThrow("supported voice")
    expect(f.requests).toHaveLength(0)
    const denied = fixture({ fetchImpl: (async () => new Response("secret-refresh", { status: 403 })) as FetchLike })
    await expect(start(denied.store)).rejects.toThrow("access denied (403)")
    expect(denied.store.hasChat("chat")).toBe(false)
})

test("401 refreshes once, retries, and never exposes upstream error text", async () => {
    let count = 0
    const f = fixture({ fetchImpl: (async () => ++count === 1 ? new Response("bad token", { status: 401 }) : new Response(sdp, { headers: { "openai-session-id": "rtc_test" } })) as FetchLike })
    await start(f.store)
    expect(f.refreshes()).toBe(1)
    expect(count).toBe(2)
    const broken = fixture({ fetchImpl: (async () => { throw new Error("Authorization: Bearer private") }) as FetchLike })
    await expect(start(broken.store)).rejects.toThrow("Check your ChatGPT sign-in")
})

test("abort during startup releases its reservation", async () => {
    const controller = new AbortController()
    controller.abort()
    const f = fixture()
    await expect(start(f.store, controller.signal)).rejects.toThrow()
    expect(f.store.hasChat("chat")).toBe(false)
    expect(f.requests).toHaveLength(0)
})

test("call IDs cannot change sideband host; unicode reply chunks preserve content", () => {
    expect(voiceCallId(new Headers({ location: "https://evil.example/rtc_safe" }))).toBe("rtc_safe")
    expect(() => voiceCallId(new Headers({ location: "https://evil.example/no-id" }))).toThrow()
    const text = "你好🐶".repeat(500)
    const chunks = voiceTextChunks(text)
    expect(chunks.join("")).toBe(text)
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 500)).toBe(true)
})
