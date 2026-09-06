import type { Database } from "bun:sqlite"
import { CredentialVault } from "./credential-vault"
export type Integration = { id: string, provider: "telegram" | "discord", name: string, updatedAt: string, checkedAt?: string, identity?: string }
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
}
