import { CredentialVault } from "./credential-vault"
import type { JsonObject } from "./agent/types"
import { fetchAccountUsage, type AccountUsage } from "./account-usage"
import { Database } from "bun:sqlite"
import { rm } from "node:fs/promises"
import { join, dirname } from "node:path"
import { login, resolveAuthFile, type AgentAuth, type AuthStorage } from "./agent/auth"
import type { AgentTurnOptions } from "./agent"
import type { AccountLogin, ConnectedAccount, LocalAccount } from "./account-types"

// Credentials are stored separately from metadata and never returned by the API.
export class AccountStore {
    private vault: CredentialVault
    private storageKeys = new Map<string, object>()
    private usageRequests = new Map<string, Promise<AccountUsage>>()
    private attempt?: { state: AccountLogin, controller: AbortController, task: Promise<void> }
    constructor(private db: Database, private directory: string, private options: AgentTurnOptions = {}) {
        db.run("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        if (!db.query<{ name: string }, []>("PRAGMA table_info(accounts)").all().some(column => column.name === "auth")) db.run("ALTER TABLE accounts ADD COLUMN auth BLOB")
        this.vault = new CredentialVault(join(dirname(directory), "auth.key"), () => !!db.query("SELECT id FROM accounts WHERE auth IS NOT NULL LIMIT 1").get())
        db.run("CREATE TABLE IF NOT EXISTS account_usage (account_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    }
    list(): ConnectedAccount[] {
        return this.db.query<{ data: string }, []>("SELECT data FROM accounts ORDER BY rowid").all().map(row => JSON.parse(row.data))
    }
    async localAccount(): Promise<LocalAccount> {
        try {
            const raw = await Bun.file(resolveAuthFile(this.options.authFile)).json()
            const tokens = raw?.tokens
            if (raw?.auth_mode !== "chatgpt" || typeof tokens?.access_token !== "string" || !tokens.access_token) return { available: false }
            const claims = (token: unknown) => {
                try { return typeof token === "string" ? JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) ?? {} : {} } catch { return {} }
            }
            const id = claims(tokens.id_token), access = claims(tokens.access_token)
            const text = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.slice(0, 254)
            return { available: true,
                email: text(id.email, access.email, access["https://api.openai.com/profile"]?.email),
                name: text(id.name, access.name, access["https://api.openai.com/profile"]?.name),
                plan: text(id["https://api.openai.com/auth"]?.chatgpt_plan_type, access["https://api.openai.com/auth"]?.chatgpt_plan_type),
            }
        } catch { return { available: false } }
    }
    authFile(id: string): string {
        if (!this.db.query("SELECT id FROM accounts WHERE id = ?").get(id)) throw new Error("This OpenAI connection is no longer available. Choose a connected account for a new chat.")
        return join(this.directory, id, "auth.json")
    }
    credentials(id: string): AuthStorage {
        this.authFile(id)
        if (!this.storageKeys.has(id)) this.storageKeys.set(id, {})
        return { key: this.storageKeys.get(id)!, read: async () => {
            const row = this.db.query<{ auth: Uint8Array | null }, [string]>("SELECT auth FROM accounts WHERE id = ?").get(id)
            if (!row) throw new Error("This OpenAI connection is no longer available.")
            if (row.auth) return this.vault.decrypt(id, row.auth)
            const raw = await Bun.file(this.authFile(id)).json()
            if (raw?.auth_mode !== "chatgpt" || !raw?.tokens?.access_token || !raw?.tokens?.refresh_token) throw new Error("Invalid saved account credentials")
            const blob = this.vault.encrypt(id, raw)
            // Verify decryption before committing, then remove the legacy plaintext only after commit.
            this.vault.decrypt(id, blob)
            this.db.query("UPDATE accounts SET auth = ? WHERE id = ? AND auth IS NULL").run(blob, id)
            await rm(join(this.directory, id), { recursive: true, force: true })
            return this.credentials(id).read()
        }, write: async raw => {
            this.authFile(id)
            const result = this.db.query("UPDATE accounts SET auth = ? WHERE id = ?").run(this.vault.encrypt(id, raw), id)
            if (result.changes !== 1) throw new Error("This OpenAI connection is no longer available.")
        } }
    }
    async migrateCredentials() {
        for (const account of this.list()) {
            await this.credentials(account.id).read()
            // Also finish cleanup after a crash between the database commit and file removal.
            await rm(join(this.directory, account.id), { recursive: true, force: true })
        }
    }
    usage(id: string): AccountUsage | null {
        if (id !== "local") this.authFile(id)
        const row = this.db.query<{ data: string }, [string]>("SELECT data FROM account_usage WHERE account_id = ?").get(id)
        return row ? JSON.parse(row.data) : null
    }
    refreshUsage(id: string): Promise<AccountUsage> {
        const authFile = id === "local" ? this.options.authFile : this.authFile(id)
        const active = this.usageRequests.get(id)
        if (active) return active
        const task = fetchAccountUsage(authFile, { ...this.options, authStorage: id === "local" ? undefined : this.credentials(id) }, this.usage(id)).then(snapshot => {
            if (id !== "local") this.authFile(id)
            this.db.query("INSERT OR REPLACE INTO account_usage (account_id, data) VALUES (?, ?)").run(id, JSON.stringify(snapshot))
            return snapshot
        }).finally(() => this.usageRequests.delete(id))
        this.usageRequests.set(id, task)
        return task
    }
    status(id: string): AccountLogin {
        if (this.attempt?.state.id !== id) throw new Error("Sign-in session not found or expired")
        return { ...this.attempt.state }
    }
    start(label: string): AccountLogin {
        if (this.attempt && ["starting", "pending"].includes(this.attempt.state.status)) return this.status(this.attempt.state.id)
        if (!label.trim() || label.length > 80) throw new Error("Give this connection a name of 1–80 characters")
        const id = crypto.randomUUID()
        const controller = new AbortController()
        const state: AccountLogin = { id, status: "starting", expiresAt: new Date(Date.now() + 300_000).toISOString() }
        const attempt = { state, controller, task: Promise.resolve() }
        this.attempt = attempt
        attempt.task = (async () => {
            try {
                controller.signal.throwIfAborted()
                let pendingAuth: JsonObject | undefined
                const common = {
                    authStorage: { key: {}, read: async () => { throw new Error("Sign-in is pending") }, write: async (raw: JsonObject) => { pendingAuth = raw } },
                    issuer: this.options.issuer, fetchImpl: this.options.fetchImpl, signal: controller.signal,
                }
                const auth = await login({ ...common,
                    onDeviceCode: (verificationUrl, userCode) => {
                        if (!controller.signal.aborted) Object.assign(state, { status: "pending", verificationUrl, userCode })
                    },
                })
                controller.signal.throwIfAborted()
                const account: ConnectedAccount = { id, provider: "openai", label: label.trim(), email: accountEmail(auth), createdAt: new Date().toISOString() }
                if (!pendingAuth) throw new Error("Sign-in did not return reusable credentials")
                this.db.query("INSERT INTO accounts (id, data, auth) VALUES (?, ?, ?)").run(id, JSON.stringify(account), this.vault.encrypt(id, pendingAuth))
                Object.assign(state, { status: "connected", account })
            } catch (error) {
                state.status = controller.signal.aborted ? "cancelled" : "error"
                state.error = controller.signal.aborted ? undefined : error instanceof Error && /status \d+|timed out|reusable credentials/.test(error.message) ? error.message : "OpenAI sign-in could not finish. Please try again."
            } finally {
                delete state.userCode
                delete state.verificationUrl
            }
        })()
        return { ...state }
    }
    async cancel(id: string): Promise<AccountLogin> {
        this.status(id)
        const attempt = this.attempt!
        if (["starting", "pending"].includes(attempt.state.status)) attempt.controller.abort()
        await attempt.task
        return this.status(id)
    }
    async remove(id: string) {
        this.authFile(id)
        await rm(join(this.directory, id), { recursive: true, force: true })
        this.db.query("DELETE FROM account_usage WHERE account_id = ?").run(id)
        this.db.query("DELETE FROM accounts WHERE id = ?").run(id)
        this.storageKeys.delete(id)
    }
    async close() {
        await Promise.allSettled(this.usageRequests.values())
        if (this.attempt) { this.attempt.controller.abort(); await this.attempt.task }
    }
}

function accountEmail(auth: AgentAuth): string | undefined {
    if (!auth.idToken) return
    try {
        const claims = JSON.parse(Buffer.from(auth.idToken.split(".")[1]!, "base64url").toString())
        return typeof claims.email === "string" ? claims.email.slice(0, 254) : undefined
    } catch { return undefined }
}
