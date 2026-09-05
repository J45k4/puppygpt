import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { ChatStore } from "./chats"
import { createChatApi } from "./chat-api"
import type { AccountLogin } from "./account-types"
import type { FetchLike } from "./agent/types"

const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const roots: string[] = []
const stores: ChatStore[] = []
afterEach(async () => {
    for (const store of stores.splice(0)) await store.close()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(fetchImpl: FetchLike) {
    const root = await mkdtemp("/tmp/puppygpt-accounts-test-")
    roots.push(root)
    const store = new ChatStore(new Database(join(root, "chats.sqlite")), root, { fetchImpl, authFile: join(root, "local-auth.json"), issuer: "https://auth.test" })
    stores.push(store)
    return { store, root, api: createChatApi(store) }
}
async function finished(store: ChatStore, id: string) {
    for (let i = 0; i < 200; i++) {
        const result = store.accounts.status(id)
        if (!["starting", "pending"].includes(result.status)) return result
        await Bun.sleep(5)
    }
    throw new Error("Sign-in did not finish")
}

test("connects multiple accounts without exposing tokens, pins credentials to chats and persists metadata", async () => {
    let accountNumber = 0
    const requestAccounts: string[] = []
    const { store, root, api } = await fixture(async (url, init) => {
        if (String(url).endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "1" })
        if (String(url).endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" })
        if (String(url).endsWith("/oauth/token")) {
            accountNumber++
            return Response.json({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: `account-${accountNumber}` }), refresh_token: `private-refresh-${accountNumber}`, id_token: jwt({ email: `account${accountNumber}@example.test` }) })
        }
        requestAccounts.push(new Headers(init?.headers).get("ChatGPT-Account-ID")!)
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready" }] }] } })}\n\n`)
    })
    const post = (path: string, body: object) => api(new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
    const start = await (await post("/api/accounts/openai/connect", { label: "Personal" })).json() as AccountLogin
    const first = await finished(store, start.id)
    expect(first.status).toBe("connected")
    expect(first.userCode).toBeUndefined()
    expect(first.account?.email).toBe("account1@example.test")
    const file = store.accounts.authFile(first.account!.id)
    expect(await Bun.file(file).exists()).toBeFalse()
    expect((await store.accounts.credentials(first.account!.id).read()).tokens).toBeDefined()
    expect(await Bun.file(join(root, "local-auth.json")).exists()).toBeFalse()
    await store.saveSettings({ ...store.settings(), accountId: first.account!.id })
    const one = await store.create()
    const second = await finished(store, store.accounts.start("Work").id)
    await store.saveSettings({ ...store.settings(), accountId: second.account!.id })
    const two = await store.create()
    store.send(one.id, "Hello personal")
    store.send(two.id, "Hello work")
    await store.settled()
    expect(requestAccounts.sort()).toEqual(["account-1", "account-2"])
    const listed = await api(new Request("http://localhost/api/accounts"))
    expect(listed.headers.get("Cache-Control")).toBe("no-store")
    const json = await listed.text()
    expect(json).not.toContain("private-refresh")
    expect(json).not.toContain("access_token")
    expect(JSON.parse(json)).toHaveLength(2)
    await store.removeAccount(first.account!.id)
    expect(() => store.send(one.id, "No fallback")).toThrow("no longer available")
    expect(await Bun.file(file).exists()).toBeFalse()
    const savedList = store.accounts.list()
    stores.splice(stores.indexOf(store), 1)
    await store.close()
    const reopened = new ChatStore(new Database(join(root, "chats.sqlite")), root)
    stores.push(reopened)
    expect(reopened.accounts.list()).toEqual(savedList)
    expect(reopened.settings().accountId).toBe(second.account!.id)
})

test("cancelling pending sign-in aborts polling and never stores an account", async () => {
    let polling!: () => void
    const started = new Promise<void>(resolve => { polling = resolve })
    const { store } = await fixture(async (url, init) => {
        if (String(url).endsWith("/usercode")) return Response.json({ device_auth_id: "id", user_code: "ABCD" })
        polling()
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
    })
    const attempt = store.accounts.start("Cancel me")
    await started
    expect(store.accounts.start("Duplicate").id).toBe(attempt.id)
    const cancelled = await store.accounts.cancel(attempt.id)
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.userCode).toBeUndefined()
    expect(store.accounts.list()).toEqual([])
})

test("account mutations reject cross-origin requests and arbitrary account ids", async () => {
    const { store, api } = await fixture(async () => { throw new Error("Must not contact provider") })
    const denied = await api(new Request("http://localhost/api/accounts/openai/connect", { method: "POST", headers: { Origin: "https://other.test", "Content-Type": "application/json" }, body: JSON.stringify({ label: "No" }) }))
    expect(denied.status).toBe(403)
    await expect(store.saveSettings({ ...store.settings(), accountId: "../../auth.json" })).rejects.toThrow()
    expect(() => store.accounts.authFile("../../auth.json")).toThrow()
    expect(store.accounts.list()).toEqual([])
})

test("usage API stores account snapshots and rejects foreign origins and missing accounts", async () => {
    const { store, api } = await fixture(async input => {
        const url = String(input)
        if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "1" })
        if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" })
        if (url.endsWith("/oauth/token")) return Response.json({ access_token: jwt({ exp: 2_000_000_000, chatgpt_account_id: "usage-account" }), refresh_token: "private-refresh" })
        if (url.endsWith("/usage")) return Response.json({ plan_type: "plus", rate_limit: null })
        if (url.endsWith("/me")) return Response.json({ stats: { lifetime_tokens: 100 } })
        return Response.json({ available_count: 0, credits: [] })
    })
    const connected = await finished(store, store.accounts.start("Usage test").id)
    const path = `http://localhost/api/accounts/${connected.account!.id}/usage`
    expect(await (await api(new Request(path))).json()).toBeNull()
    const refreshed = await api(new Request(`${path}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(refreshed.status).toBe(200)
    expect(refreshed.headers.get("Cache-Control")).toBe("no-store")
    const snapshot = await refreshed.json()
    expect(snapshot.profile.data.lifetimeTokens).toBe(100)
    expect(await (await api(new Request(path))).json()).toEqual(snapshot)
    expect((await api(new Request(path, { headers: { Origin: "https://foreign.test" } }))).status).toBe(403)
    expect((await api(new Request(`${path}/refresh`, { method: "POST", headers: { Origin: "https://foreign.test", "Content-Type": "application/json" }, body: "{}" }))).status).toBe(403)
    expect((await api(new Request(`http://localhost/api/accounts/${crypto.randomUUID()}/usage`))).status).toBe(400)
})

test("local account metadata exposes only display fields without refreshing credentials", async () => {
    const { root, api } = await fixture(async () => { throw new Error("Metadata must not call OpenAI") })
    const request = () => api(new Request("http://localhost/api/accounts/local"))
    expect(await (await request()).json()).toEqual({ available: false })
    const authFile = join(root, "local-auth.json")
    const raw = JSON.stringify({ auth_mode: "chatgpt", tokens: {
        access_token: jwt({ exp: 1, "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "private-id" } }),
        id_token: jwt({ email: "local@example.test", name: "Local User" }), refresh_token: "private-refresh",
    } })
    await Bun.write(authFile, raw)
    const response = await request()
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({ available: true, email: "local@example.test", name: "Local User", plan: "pro" })
    expect(await Bun.file(authFile).text()).toBe(raw)
    await Bun.write(authFile, "invalid json")
    expect(await (await request()).json()).toEqual({ available: false })
})
