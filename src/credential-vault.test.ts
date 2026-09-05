import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { CredentialVault } from "./credential-vault"
import { AccountStore } from "./accounts"
import { getFreshAuth } from "./agent/auth"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function root() { const path = await mkdtemp("/tmp/puppygpt-vault-"); roots.push(path); return path }
const jwt = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp, chatgpt_account_id: "provider-account" })).toString("base64url")}.sig`
const raw = { auth_mode: "chatgpt", tokens: { access_token: jwt(1), refresh_token: "secret-refresh-original" } }

test("authenticated encryption uses unique nonces and rejects tampering, swapped accounts and missing keys", async () => {
    const path = await root(); let stored = false
    const vault = new CredentialVault(`${path}/auth.key`, () => stored)
    const a = vault.encrypt("one", raw), b = vault.encrypt("one", raw); stored = true
    expect(a.equals(b)).toBeFalse()
    expect(a.toString()).not.toContain("secret-refresh")
    expect(vault.decrypt("one", a)).toEqual(raw)
    expect((await stat(`${path}/auth.key`)).mode & 0o777).toBe(0o600)
    expect(() => vault.decrypt("two", a)).toThrow("Could not decrypt")
    const bad = Buffer.from(a); bad[bad.length - 1]! ^= 1
    expect(() => vault.decrypt("one", bad)).toThrow("Could not decrypt")
    await Bun.write(`${path}/auth.key`, new Uint8Array(32))
    expect(() => vault.decrypt("one", a)).toThrow("Could not decrypt")
    await rm(`${path}/auth.key`)
    expect(() => vault.decrypt("one", a)).toThrow("key is missing")
    expect(await Bun.file(`${path}/auth.key`).exists()).toBeFalse()
})

test("legacy credentials migrate to a blob and refreshed tokens persist without plaintext files", async () => {
    const path = await root(); let db = new Database(`${path}/db.sqlite`)
    db.run("CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
    const id = crypto.randomUUID()
    db.query("INSERT INTO accounts VALUES (?, ?)").run(id, JSON.stringify({ id, label: "Legacy", provider: "openai" }))
    const legacyFile = `${path}/accounts/${id}/auth.json`
    await Bun.write(legacyFile, JSON.stringify(raw))
    let store = new AccountStore(db, `${path}/accounts`)
    await store.migrateCredentials()
    expect(await Bun.file(legacyFile).exists()).toBeFalse()
    const row = db.query<{ auth: Uint8Array, kind: string }, []>("SELECT auth, typeof(auth) AS kind FROM accounts").get()!
    expect(row.kind).toBe("blob")
    expect(Buffer.from(row.auth).toString()).not.toContain("secret-refresh")
    let calls = 0
    const storage = store.credentials(id)
    const fetchImpl = async () => { calls++; await Bun.sleep(5); return Response.json({ access_token: jwt(2_000_000_000), refresh_token: "secret-refresh-rotated" }) }
    const [a,b] = await Promise.all([getFreshAuth({ authStorage: storage, fetchImpl }), getFreshAuth({ authStorage: store.credentials(id), fetchImpl })])
    expect(calls).toBe(1); expect(a.refreshToken).toBe(b.refreshToken)
    await store.close(); db.close()
    db = new Database(`${path}/db.sqlite`); store = new AccountStore(db, `${path}/accounts`)
    expect((await getFreshAuth({ authStorage: store.credentials(id), fetchImpl })).refreshToken).toBe("secret-refresh-rotated")
    expect(calls).toBe(1)
    expect(await Bun.file(legacyFile).exists()).toBeFalse()
    const reopenedStorage = store.credentials(id)
    await store.remove(id)
    expect(db.query("SELECT auth FROM accounts").all()).toHaveLength(0)
    await expect(reopenedStorage.write(raw)).rejects.toThrow("no longer available")
    await store.close(); db.close()
})

test("failed migration leaves the legacy credential file recoverable", async () => {
    const path = await root(); const db = new Database(`${path}/db.sqlite`)
    const store = new AccountStore(db, `${path}/accounts`)
    const id = crypto.randomUUID()
    db.query("INSERT INTO accounts (id, data) VALUES (?, ?)").run(id, JSON.stringify({ id, provider: "openai" }))
    const legacy = `${path}/accounts/${id}/auth.json`
    await Bun.write(legacy, JSON.stringify(raw))
    await Bun.write(`${path}/auth.key`, "invalid-key")
    await expect(store.migrateCredentials()).rejects.toThrow("key is invalid")
    expect(await Bun.file(legacy).json()).toEqual(raw)
    expect(db.query<{ auth: unknown }, []>("SELECT auth FROM accounts").get()!.auth).toBeNull()
    await store.close(); db.close()
})
