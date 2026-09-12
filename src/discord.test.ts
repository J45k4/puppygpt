import { expect, test } from "bun:test"
import { DiscordListener, discordEvent } from "./discord"
import { DiscordReceivers } from "./discord-receivers"
import { ChatStore } from "./chats"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"

class Socket {
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    sent: any[] = []
    closed = false
    send(data: string) { this.sent.push(JSON.parse(data)) }
    close() { this.closed = true }
    packet(op: number, d: unknown, t?: string, s?: number) { this.onmessage?.({ data: JSON.stringify({ op, d, t, s }) }) }
}
const message = { id: "123", channel_id: "456", guild_id: "789", content: "hello from Discord", author: { id: "42", username: "user" } }
const tick = () => Bun.sleep(10)
function fixture(deliver = async (_: any) => ({ delivered: ["chat"] })) {
    const sockets: Socket[] = []
    const urls: string[] = []
    const options = { fetchImpl: (async () => Response.json({ url: "wss://gateway.discord.gg" })), socket: (url: string) => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket }, retryMs: 1, random: () => 0.5 }
    const listener = new DiscordListener("integration", "private-token", deliver, options)
    return { listener, sockets, urls, options }
}
function ready(socket: Socket) { socket.packet(10, { heartbeat_interval: 10000 }); socket.packet(0, { session_id: "session", resume_gateway_url: "wss://gateway-us-east1-b.discord.gg" }, "READY", 1) }

test("Discord maps channel and direct messages and ignores bots/webhooks", () => {
    expect(discordEvent("integration", message)).toMatchObject({ event: { type: "message.created", provider: "discord" }, conversation: { id: "456", type: "guild" }, message: { text: message.content } })
    expect(discordEvent("integration", { ...message, guild_id: undefined })?.conversation?.type).toBe("direct")
    expect(discordEvent("integration", { ...message, author: { id: "42", bot: true } })).toBeNull()
    expect(discordEvent("integration", { ...message, webhook_id: "hook" })).toBeNull()
    expect(discordEvent("integration", { ...message, content: "", attachments: [{ filename: "photo.png" }] })?.message?.text).toContain("photo.png")
})

test("Gateway identifies, deduplicates messages, resumes and shuts down", async () => {
    const received: any[] = []
    const { listener, sockets, urls } = fixture(async event => { received.push(event); return { delivered: ["chat"] } })
    listener.start(); await tick()
    try {
        ready(sockets[0]!)
        expect(sockets[0]!.sent[0]).toMatchObject({ op: 2, d: { token: "private-token", intents: 37376 } })
        sockets[0]!.packet(0, message, "MESSAGE_CREATE", 2)
        sockets[0]!.packet(0, message, "MESSAGE_CREATE", 3)
        await listener.settled()
        expect(received).toHaveLength(1)
        expect(listener.status).toMatchObject({ state: "connected", received: 1, delivered: 1 })
        sockets[0]!.packet(7, null); await tick()
        sockets[1]!.packet(10, { heartbeat_interval: 10000 })
        expect(urls[1]).toContain("gateway-us-east1-b.discord.gg")
        expect(sockets[1]!.sent[0]).toMatchObject({ op: 6, d: { session_id: "session", seq: 3 } })
        sockets[1]!.packet(0, {}, "RESUMED", 4)
        sockets[1]!.packet(1, null)
        expect(sockets[1]!.sent.at(-1)).toEqual({ op: 1, d: 4 })
    } finally { await listener.stop() }
    expect(sockets.at(-1)!.closed).toBeTrue()
    await tick(); expect(sockets).toHaveLength(2)
})

test("missing heartbeat ACK reconnects; forbidden intent stops with actionable status", async () => {
    const { listener, sockets } = fixture()
    listener.start(); await tick()
    try {
        sockets[0]!.packet(10, { heartbeat_interval: 10 })
        await Bun.sleep(40)
        expect(sockets.length).toBeGreaterThan(1)
        sockets.at(-1)!.onclose?.({ code: 4014 })
        const count = sockets.length
        await tick()
        expect(sockets).toHaveLength(count)
        expect(listener.status).toMatchObject({ state: "error" })
        expect(listener.status.error).toContain("Message Content Intent")
        expect(JSON.stringify(listener.status)).not.toContain("private-token")
    } finally { await listener.stop() }
})

test("invalid sessions re-identify and routing failures do not break subsequent delivery", async () => {
    let calls = 0
    const { listener, sockets } = fixture(async () => { if (++calls === 1) throw new Error("private-token"); return { delivered: ["chat"] } })
    listener.start(); await tick()
    try {
        ready(sockets[0]!)
        sockets[0]!.packet(0, message, "MESSAGE_CREATE", 2); await listener.settled()
        expect(listener.status.error).toContain("Could not route")
        expect(listener.status.error).not.toContain("private-token")
        sockets[0]!.packet(9, false); await tick()
        ready(sockets[1]!)
        expect(sockets[1]!.sent[0].op).toBe(2)
        sockets[1]!.packet(0, { ...message, id: "124" }, "MESSAGE_CREATE", 2); await listener.settled()
        expect(listener.status.delivered).toBe(1)
    } finally { await listener.stop() }
})

test("enabled Discord subscription receives Gateway message into real chat store; rotation and disable reconcile", async () => {
    const root = await mkdtemp("/tmp/puppygpt-discord-")
    const authFile = `${root}/auth.json`
    const access = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `x.${access}.x`, refresh_token: "refresh" } }))
    const sse = new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Received" }] } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "response-1" } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
    const store = new ChatStore(new Database(":memory:"), root, { authFile, fetchImpl: async () => sse.clone() })
    const { sockets, options } = fixture()
    const receivers = new DiscordReceivers(store.integrations, store.routing, event => store.routeSubscriptionEvent(event), options)
    try {
        const integration = store.integrations.save({ provider: "discord", name: "Test", token: "fake.token" })
        receivers.start(); await tick(); expect(sockets).toHaveLength(0)
        const chat = await store.create(root)
        const rule = store.routing.putRule({ name: "Discord channel", source: { integrationId: integration.id }, when: { op: "eq", field: "conversation.id", value: "456" }, actions: [{ type: "deliver", destination: { kind: "chat", chatId: chat.id } }] }, 0)
        receivers.sync(); await tick(); ready(sockets[0]!)
        sockets[0]!.packet(0, message, "MESSAGE_CREATE", 2)
        await tick(); await store.settled()
        expect(store.get(chat.id)?.messages.map(m => [m.role, m.text])).toEqual([["user", `discord · user · channel 456\n${message.content}`], ["assistant", "Received"]])
        expect(store.get(chat.id)?.messages[0]?.detail).toContain('"provider": "discord"')
        expect(store.get(chat.id)?.messages[0]?.detail).toContain('"integrationId":')
        expect(receivers.statuses()[integration.id]?.delivered).toBe(1)
        store.integrations.save({ provider: "discord", name: "Test", token: "replacement.token" }, integration.id)
        receivers.sync(); await tick(); expect(sockets[0]!.closed).toBeTrue(); ready(sockets[1]!)
        expect(sockets[1]!.sent[0].d.token).toBe("replacement.token")
        store.routing.putRule({ ...rule, enabled: false }, 1, rule.id)
        receivers.sync(); expect(sockets[1]!.closed).toBeTrue(); expect(receivers.statuses()).toEqual({})
    } finally { await receivers.close(); await store.close(); await rm(root, { recursive: true, force: true }) }
})
