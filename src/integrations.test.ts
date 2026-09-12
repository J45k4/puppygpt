import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { IntegrationStore } from "./integrations"

test("integration credentials are encrypted, survive restart, and never appear in metadata", async () => {
    const root = await mkdtemp("/tmp/puppygpt-integrations-")
    let db = new Database(`${root}/db.sqlite`)
    try {
        let store = new IntegrationStore(db, `${root}/integrations.key`)
        const item = store.save({ provider: "telegram", name: "My bot", token: "123456:secret-token" })
        expect(JSON.stringify(store.list())).not.toContain("secret-token")
        const row = db.query("SELECT data, auth FROM integrations").get() as { data: string, auth: Uint8Array }
        expect(row.data).not.toContain("secret-token")
        expect(Buffer.from(row.auth).toString()).not.toContain("secret-token")
        db.close(); db = new Database(`${root}/db.sqlite`)
        let calls = 0
        store = new IntegrationStore(db, `${root}/integrations.key`, (async (url: string) => {
            calls++; expect(url).toBe("https://api.telegram.org/bot123456:secret-token/getMe")
            return Response.json({ ok: true, result: { is_bot: true, username: "test_bot" } })
        }))
        expect((await store.test(item.id)).identity).toBe("@test_bot")
        expect(calls).toBe(1)
        expect(store.save({ provider: "telegram", name: "Renamed" }, item.id).identity).toBe("@test_bot")
        expect(store.save({ provider: "telegram", name: "Renamed", token: "123456:new-token" }, item.id).identity).toBeUndefined()
        store.remove(item.id); expect(store.list()).toEqual([])
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("Discord tests use bot authentication and reject non-bot accounts without leaking credentials", async () => {
    const root = await mkdtemp("/tmp/puppygpt-integrations-")
    const db = new Database(":memory:")
    try {
        const token = "discord.secret.token"
        const store = new IntegrationStore(db, `${root}/integrations.key`, (async (url: string, init?: RequestInit) => {
            expect(url).toBe("https://discord.com/api/v10/users/@me")
            expect(new Headers(init?.headers).get("Authorization")).toBe(`Bot ${token}`)
            return Response.json({ username: "normal_user", bot: false })
        }))
        const item = store.save({ provider: "discord", name: "Discord", token })
        await expect(store.test(item.id)).rejects.toThrow("Connection test failed")
        expect(store.list()[0]?.identity).toBeUndefined()
        const failing = new IntegrationStore(db, `${root}/integrations.key`, (async () => { throw new Error(`Sensitive URL ${token}`) }))
        try { await failing.test(item.id); throw new Error("Expected failure") } catch (error) { expect(String(error)).not.toContain(token) }
        expect(() => store.save({ provider: "telegram", name: "Changed" }, item.id)).toThrow("change services")
        expect(() => store.save({ provider: "other", name: "No", token })).toThrow("Telegram or Discord")
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("integration channels list Discord guild text channels without leaking tokens", async () => {
    const root = await mkdtemp("/tmp/puppygpt-integrations-")
    const db = new Database(":memory:")
    try {
        const token = "discord.secret.token"
        const seen: string[] = []
        const store = new IntegrationStore(db, `${root}/integrations.key`, (async (url: string, init?: RequestInit) => {
            seen.push(url)
            expect(new Headers(init?.headers).get("Authorization")).toBe(`Bot ${token}`)
            if (url === "https://discord.com/api/v10/users/@me/guilds") return Response.json([{ id: "g1", name: "Guild" }])
            if (url === "https://discord.com/api/v10/guilds/g1/channels") return Response.json([
                { id: "c1", name: "general", type: 0 },
                { id: "c2", name: "voice", type: 2 },
                { id: "c3", name: "news", type: 5 },
            ])
            throw new Error("unexpected url")
        }))
        const item = store.save({ provider: "discord", name: "Discord", token })
        expect(await store.channels(item.id)).toEqual([
            { id: "c1", name: "#general · Guild", kind: "guild" },
            { id: "c3", name: "#news · Guild", kind: "guild" },
        ])
        expect(seen).toHaveLength(2)
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("integration channels list Telegram recent chats and hide failures", async () => {
    const root = await mkdtemp("/tmp/puppygpt-integrations-")
    const db = new Database(":memory:")
    try {
        const store = new IntegrationStore(db, `${root}/integrations.key`, (async (url: string) => {
            expect(url).toContain("/getUpdates")
            return Response.json({ ok: true, result: [
                { message: { chat: { id: -100, title: "Group", type: "supergroup" } } },
                { message: { chat: { id: 42, first_name: "Teppo", type: "private" } } },
            ] })
        }))
        const item = store.save({ provider: "telegram", name: "Telegram", token: "123456:secret-token" })
        expect(await store.channels(item.id)).toEqual([
            { id: "-100", name: "Group", kind: "supergroup" },
            { id: "42", name: "Teppo", kind: "private" },
        ])
        const failing = new IntegrationStore(db, `${root}/integrations.key`, (async () => { throw new Error("boom secret-token") }))
        await expect(failing.channels(item.id)).rejects.toThrow("Could not list channels")
        try { await failing.channels(item.id) } catch (error) { expect(String(error)).not.toContain("secret-token") }
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})

test("integration settings API preserves origin checks and returns metadata only", async () => {
    const { ChatStore } = await import("./chats")
    const { createChatApi } = await import("./chat-api")
    const root = await mkdtemp("/tmp/puppygpt-integrations-api-")
    const store = new ChatStore(new Database(":memory:"), root)
    try {
        const api = createChatApi(store)
        const body = JSON.stringify({ provider: "telegram", name: "Telegram", token: "123456:private-token" })
        const post = (origin?: string) => api(new Request("http://localhost/api/integrations", { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body }))
        expect((await post("https://foreign.test")).status).toBe(403)
        expect(store.integrations.list()).toHaveLength(0)
        const created = await post()
        expect(created.status).toBe(201)
        expect(await created.text()).not.toContain("private-token")
        const list = await api(new Request("http://localhost/api/integrations"))
        expect(await list.text()).not.toContain("private-token")
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
