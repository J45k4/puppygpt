import type { Database } from "bun:sqlite"
import { CredentialVault } from "./credential-vault"
export type Integration = { id: string, provider: "telegram" | "discord", name: string, updatedAt: string, checkedAt?: string, identity?: string }
export type IntegrationChannel = { id: string, name: string, kind: string }
export class IntegrationStore {
    private vault: CredentialVault
    constructor(private db: Database, keyPath: string, private fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
        db.run("CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, data TEXT NOT NULL, auth BLOB NOT NULL)")
        this.vault = new CredentialVault(keyPath, () => !!db.query("SELECT id FROM integrations LIMIT 1").get())
    }
    list(): Integration[] { return this.db.query<{ data: string }, []>("SELECT data FROM integrations ORDER BY rowid").all().map(row => JSON.parse(row.data)) }
    private row(id: string) {
        const row = this.db.query<{ data: string, auth: Uint8Array }, [string]>("SELECT data, auth FROM integrations WHERE id = ?").get(id)
        if (!row) throw new Error("Integration not found")
        return row
    }
    // Server-only credential access; never include this in API metadata.
    botToken(id: string): string {
        const row = this.row(id)
        const { token } = this.vault.decrypt(`integration:${id}`, row.auth)
        if (typeof token !== "string" || !token) throw new Error("Saved bot token is invalid")
        return token
    }
    async sendDiscord(id: string, channelId: string, text: string, replyTo?: string) {
        if (!/^\d{1,20}$/.test(channelId) || (replyTo !== undefined && !/^\d{1,20}$/.test(replyTo))) throw new Error("Invalid Discord channel or reply ID")
        if (!text.trim() || text.length > 2000) throw new Error("Message text must be 1–2000 characters")
        const integration = this.list().find(item => item.id === id)
        if (integration?.provider !== "discord") throw new Error("Choose an existing Discord integration")
        let token: string
        try { token = this.botToken(id) } catch { throw new Error("Cannot read bot credentials. Edit the integration to replace the token.") }
        try {
            const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000),
                body: JSON.stringify({ content: text, allowed_mentions: { parse: [], replied_user: false }, nonce: crypto.randomUUID().replaceAll("-", "").slice(0, 25), enforce_nonce: true,
                    ...(replyTo ? { message_reference: { message_id: replyTo, channel_id: channelId, fail_if_not_exists: true } } : {}) }),
            })
            if (!response.ok) return { status: response.status >= 500 ? "unknown" : "failed", error: response.status === 429 ? "Discord rate limit reached. Wait before trying again." : response.status === 403 ? "The bot lacks permission to send here. Check Send Messages and, for replies, Read Message History." : response.status === 401 ? "Discord rejected the bot token." : `Discord rejected the message (HTTP ${response.status}).` }
            const message = await response.json()
            if (typeof message.id !== "string" || !/^\d{1,20}$/.test(message.id) || message.channel_id !== channelId) return { status: "unknown", error: "Discord returned an unexpected result. Check the channel before retrying." }
            return { status: "sent", message_id: message.id, url: `https://discord.com/channels/${typeof message.guild_id === "string" && /^\d{1,20}$/.test(message.guild_id) ? message.guild_id : "@me"}/${channelId}/${message.id}` }
        } catch { return { status: "unknown", error: "Discord delivery could not be confirmed. Check the channel before retrying to avoid duplicates." } }
    }
    save(value: unknown, id?: string): Integration {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected integration settings")
        const v = value as Record<string, unknown>
        if (v.provider !== "telegram" && v.provider !== "discord") throw new Error("Choose Telegram or Discord")
        if (typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 80) throw new Error("Enter a name of 1–80 characters")
        const existing = id ? this.row(id) : undefined
        const old: Integration | undefined = existing ? JSON.parse(existing.data) : undefined
        if (old && old.provider !== v.provider) throw new Error("Create a new connection to change services")
        if (v.token !== undefined && typeof v.token !== "string") throw new Error("Invalid bot token")
        const token = typeof v.token === "string" ? v.token.trim() : ""
        if (!existing && !token) throw new Error("Enter a bot token")
        if (token && (token.length > 512 || /\s/.test(token) || (v.provider === "telegram" ? !/^\d+:[A-Za-z0-9_-]+$/.test(token) : !/^[A-Za-z0-9_.-]+$/.test(token)))) throw new Error("Invalid bot token format")
        const connection: Integration = { ...(token ? {} : old), id: id ?? crypto.randomUUID(), provider: v.provider, name: v.name.trim(), updatedAt: new Date().toISOString() }
        const auth = token ? this.vault.encrypt(`integration:${connection.id}`, { token }) : existing!.auth
        this.db.query("INSERT INTO integrations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, auth = excluded.auth").run(connection.id, JSON.stringify(connection), auth)
        return connection
    }
    remove(id: string) { this.row(id); this.db.query("DELETE FROM integrations WHERE id = ?").run(id) }
    async test(id: string): Promise<Integration> {
        const row = this.row(id)
        const integration: Integration = JSON.parse(row.data)
        const { token } = this.vault.decrypt(`integration:${id}`, row.auth)
        if (typeof token !== "string") throw new Error("Saved bot token is invalid")
        let identity: string
        try {
            const response = await this.fetchImpl(integration.provider === "telegram" ? `https://api.telegram.org/bot${token}/getMe` : "https://discord.com/api/v10/users/@me", {
                headers: integration.provider === "discord" ? { Authorization: `Bot ${token}` } : {},
                signal: AbortSignal.timeout(10000), redirect: "error",
            })
            if (!response.ok) throw new Error()
            const body = await response.json()
            const bot = integration.provider === "telegram" ? body.ok && body.result : body
            if (!bot || !(integration.provider === "telegram" ? bot.is_bot : bot.bot) || typeof bot.username !== "string") throw new Error()
            identity = `@${bot.username}`
        } catch {
            // Telegram URLs contain the credential; never expose fetch errors or provider bodies.
            throw new Error("Connection test failed. Check the bot token and network access.")
        }
        // A test for replaced credentials must not mark the replacement as verified.
        const latest = this.row(id)
        if (!Buffer.from(latest.auth).equals(Buffer.from(row.auth))) throw new Error("The token changed during the test. Test the connection again.")
        const verified = { ...JSON.parse(latest.data), checkedAt: new Date().toISOString(), identity } as Integration
        this.db.query("UPDATE integrations SET data = ? WHERE id = ?").run(JSON.stringify(verified), id)
        return verified
    }
    async channels(id: string): Promise<IntegrationChannel[]> {
        const row = this.row(id)
        const integration: Integration = JSON.parse(row.data)
        const { token } = this.vault.decrypt(`integration:${id}`, row.auth)
        if (typeof token !== "string" || !token) throw new Error("Saved bot token is invalid")
        try {
            if (integration.provider === "discord") return await this.discordChannels(token)
            return await this.telegramChannels(token)
        } catch {
            // URLs/headers carry the credential; keep errors generic.
            throw new Error("Could not list channels. Check the bot token, server membership, and network access.")
        }
    }
    private async discordChannels(token: string): Promise<IntegrationChannel[]> {
        const get = async (path: string) => {
            const response = await this.fetchImpl(`https://discord.com/api/v10${path}`, {
                headers: { Authorization: `Bot ${token}` },
                signal: AbortSignal.timeout(10000), redirect: "error",
            })
            if (!response.ok) throw new Error(`Discord ${path} failed`)
            return response.json()
        }
        const guilds = await get("/users/@me/guilds") as { id: string, name: string }[]
        if (!Array.isArray(guilds)) throw new Error("Unexpected guild list")
        const channels: IntegrationChannel[] = []
        for (const guild of guilds.slice(0, 50)) {
            if (!guild || typeof guild.id !== "string") continue
            const list = await get(`/guilds/${guild.id}/channels`) as { id: string, name: string, type: number }[]
            if (!Array.isArray(list)) continue
            for (const channel of list) {
                if (!channel || typeof channel.id !== "string" || typeof channel.name !== "string") continue
                if (channel.type !== 0 && channel.type !== 5) continue
                channels.push({ id: channel.id, name: `#${channel.name} · ${guild.name}`, kind: "guild" })
            }
            if (channels.length >= 500) break
        }
        return channels.slice(0, 500)
    }
    private async telegramChannels(token: string): Promise<IntegrationChannel[]> {
        // Telegram has no list-all-chats API; recent updates are the best signal.
        const response = await this.fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=0`, {
            signal: AbortSignal.timeout(10000), redirect: "error",
        })
        if (!response.ok) throw new Error("Telegram getUpdates failed")
        const body = await response.json() as { ok: boolean, result: { message?: { chat: { id: number, title?: string, username?: string, first_name?: string, type?: string } } }[] }
        if (!body?.ok || !Array.isArray(body.result)) throw new Error("Unexpected updates list")
        const seen = new Map<string, IntegrationChannel>()
        for (const update of body.result) {
            const chat = update?.message?.chat
            if (!chat || seen.has(String(chat.id))) continue
            const label = chat.title ?? (chat.username ? `@${chat.username}` : chat.first_name ?? String(chat.id))
            seen.set(String(chat.id), { id: String(chat.id), name: `${label}`, kind: chat.type ?? "chat" })
        }
        return [...seen.values()].slice(0, 100)
    }
}
