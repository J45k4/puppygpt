import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { DiscordSendStore } from "./discord-send"
import { IntegrationStore } from "./integrations"
import { RoutingStore } from "./routing"

test("Discord sends bind integration and channel, preserve text, suppress mentions, and support replies", async () => {
    const root = await mkdtemp("/tmp/puppygpt-discord-send-")
    const db = new Database(":memory:")
    const calls: { url: string, init?: RequestInit }[] = []
    let response = () => Promise.resolve(Response.json({ id: "999", channel_id: "456", guild_id: "789" }))
    try {
        const integrations = new IntegrationStore(db, `${root}/key`, async (url, init) => { calls.push({ url, init }); return response() })
        const a = integrations.save({ name: "A", provider: "discord", token: "secret.a" })
        const b = integrations.save({ name: "B", provider: "discord", token: "secret.b" })
        const routing = new RoutingStore(db)
        const rule = routing.putRule({ name: "Discord", source: { integrationId: "*" }, when: { op: "exists", field: "event.id" }, actions: [{ type: "deliver", destination: { kind: "chat", chatId: "chat" } }] }, 0)
        const store = new DiscordSendStore(db, integrations, routing)
        for (const integrationId of [a.id, b.id]) store.grant("chat", { event: { id: "123", integrationId, type: "message.created", provider: "discord" }, conversation: { id: "456" } })
        const tool = store.agentTool("chat")
        const args = { integration_id: a.id, channel_id: "456", text: "hello @everyone", reply_to_message_id: "123" }
        expect(await tool.execute(args)).toMatchObject({ ...args, status: "sent", message_id: "999", url: "https://discord.com/channels/789/456/999" })
        expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/456/messages")
        expect(new Headers(calls[0]!.init?.headers).get("Authorization")).toBe("Bot secret.a")
        expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ content: args.text, allowed_mentions: { parse: [], replied_user: false }, message_reference: { message_id: "123", channel_id: "456", fail_if_not_exists: true }, enforce_nonce: true })
        expect(await tool.execute({ integration_id: b.id, channel_id: "456", text: "second bot" })).toMatchObject({ status: "sent" })
        expect(new Headers(calls[1]!.init?.headers).get("Authorization")).toBe("Bot secret.b")
        expect(JSON.parse(String(calls[1]!.init?.body)).message_reference).toBeUndefined()
        for (const invalid of [{ ...args, channel_id: "457" }, { ...args, channel_id: "../other" }, { ...args, text: " " }, { ...args, text: "a".repeat(2001) }, { ...args, reply_to_message_id: "bad" }]) expect(await tool.execute(invalid)).toMatchObject({ status: "failed" })
        expect(await store.agentTool("other-chat").execute(args)).toMatchObject({ status: "failed" })
        expect(calls).toHaveLength(2)
        response = () => Promise.resolve(new Response(null, { status: 403 }))
        expect(await tool.execute(args)).toMatchObject({ status: "failed", error: expect.stringContaining("permission") })
        response = () => Promise.resolve(new Response(null, { status: 429 }))
        expect(await tool.execute(args)).toMatchObject({ status: "failed", error: expect.stringContaining("rate limit") })
        response = () => Promise.reject(new Error("secret.a"))
        const unknown = await tool.execute(args)
        expect(unknown).toMatchObject({ status: "unknown" }); expect(JSON.stringify(unknown)).not.toContain("secret.a")
        routing.putRule({ ...rule, enabled: false }, 1, rule.id)
        const count = calls.length
        expect(await tool.execute(args)).toMatchObject({ status: "failed", error: expect.stringContaining("no longer permits") })
        expect(calls).toHaveLength(count)
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("agent executes Discord tool and persists the exact send and result as visible activity", async () => {
    const { ChatStore } = await import("./chats")
    const root = await mkdtemp("/tmp/puppygpt-discord-tool-")
    const authFile = `${root}/auth.json`
    const access = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `x.${access}.x`, refresh_token: "refresh" } }))
    let integrationId = "", requests = 0
    const store = new ChatStore(new Database(":memory:"), root, { authFile, fetchImpl: async () => {
        const item = requests++ === 0 ? { type: "function_call", name: "discord_send_message", call_id: "send-1", arguments: JSON.stringify({ integration_id: integrationId, channel_id: "456", text: "Hello back", reply_to_message_id: "123" }) } : { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sent in Discord." }] }
        return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `response-${requests}` } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
    } })
    try {
        integrationId = store.integrations.save({ provider: "discord", name: "Bot", token: "fake.token" }).id
        const sends: unknown[] = []
        store.integrations.sendDiscord = async (...args) => { sends.push(args); return { status: "sent", message_id: "999", url: "https://discord.com/channels/789/456/999" } }
        const chat = await store.create(root)
        store.routing.putRule({ name: "Discord", source: { integrationId }, when: { op: "exists", field: "event.id" }, actions: [{ type: "deliver", destination: { kind: "chat", chatId: chat.id } }] }, 0)
        await store.routeSubscriptionEvent({ event: { id: "123", integrationId, provider: "discord", type: "message.created" }, conversation: { id: "456" }, message: { id: "123", text: "hello" } })
        await store.settled()
        expect(sends).toEqual([[integrationId, "456", "Hello back", "123"]])
        const messages = store.get(chat.id)!.messages
        expect(messages[0]?.detail).toContain("To reply in Discord, use discord_send_message")
        const activity = messages.find(message => message.role === "activity" && message.text.startsWith("Discord sent"))
        expect(activity?.running).toBeFalse()
        expect(JSON.parse(activity!.detail!)).toMatchObject({ status: "sent", text: "Hello back", channel_id: "456", integration_id: integrationId, reply_to_message_id: "123", message_id: "999" })
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
