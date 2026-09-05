import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { AccountStore } from "./accounts"
import { fetchAccountUsage } from "./account-usage"
import type { FetchLike } from "./agent/types"
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
    const root = await mkdtemp("/tmp/puppygpt-usage-test-"); roots.push(root)
    const authFile = `${root}/auth.json`
    const token = `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000, chatgpt_account_id: "test-account" })).toString("base64url")}.sig`
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, refresh_token: "private-refresh", account_id: "test-account" } }))
    return { root, authFile }
}
const replies = {
    usage: { plan_type: "pro", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2_000_000_000 }, secondary_window: null }, additional_rate_limits: [{ limit_name: "Extra", rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 2_000_000_001 } } }], credits: { balance: "12.50", unlimited: false }, rate_limit_reset_credits: { available_count: 2 }, access_token: "must-not-store" },
    me: { stats: { lifetime_tokens: 1234567, peak_daily_tokens: 0, current_streak_days: null, daily_usage_buckets: [{ start_date: "2026-09-04", tokens: 123 }] } },
    "rate-limit-reset-credits": { available_count: 2, credits: [{ id: "private-credit-id", title: "Bonus", status: "available", expires_at: null }] },
}
test("fetches all usage sections with the selected account, preserves unknown values, and strips unneeded fields", async () => {
    const { authFile } = await fixture(); const paths: string[] = []
    const fetchImpl: FetchLike = async (input, init) => {
        paths.push(String(input))
        expect(new Headers(init?.headers).get("ChatGPT-Account-ID")).toBe("test-account")
        expect(new Headers(init?.headers).get("Authorization")).toStartWith("Bearer ")
        expect(init?.method ?? "GET").toBe("GET")
        return Response.json(replies[String(input).split("/").at(-1)! as keyof typeof replies])
    }
    const s = await fetchAccountUsage(authFile, { fetchImpl }, null)
    expect(paths).toHaveLength(3); expect(paths.every(p => p.startsWith("https://chatgpt.com/backend-api/wham/"))).toBeTrue()
    expect(s.limits.data?.windows[0]?.primary?.usedPercent).toBe(25)
    expect(s.limits.data?.windows[0]?.secondary).toBeNull()
    expect(s.limits.data?.windows[1]?.primary?.usedPercent).toBe(100)
    expect(s.profile.data?.lifetimeTokens).toBe(1234567)
    expect(s.profile.data?.peakDailyTokens).toBe(0)
    expect(s.profile.data?.currentStreakDays).toBeNull()
    expect(s.resets.data?.available).toBe(2)
    expect(JSON.stringify(s)).not.toContain("private")
    expect(JSON.stringify(s)).not.toContain("must-not-store")
    const failed = await fetchAccountUsage(authFile, { fetchImpl: async () => new Response("secret provider error", { status: 403 }) }, s)
    expect(failed.limits.data).toEqual(s.limits.data)
    expect(failed.limits.fetchedAt).toBe(s.limits.fetchedAt)
    expect(failed.profile.error).toContain("403")
    expect(JSON.stringify(failed)).not.toContain("secret provider error")
    const partial = await fetchAccountUsage(authFile, { fetchImpl: async input => String(input).endsWith("/usage") ? Response.json(replies.usage) : Response.json({ unexpected: true }) }, null)
    expect(partial.limits.error).toBeNull()
    expect(partial.profile.data).toBeNull()
    expect(partial.profile.error).not.toBeNull()
})
test("persists snapshots across stores, coalesces refreshes, and deletes removed-account data", async () => {
    const { root, authFile } = await fixture(); const db = new Database(`${root}/test.sqlite`)
    let calls = 0
    const options = { authFile, fetchImpl: (async input => { calls++; await Bun.sleep(5); return Response.json(replies[String(input).split("/").at(-1)! as keyof typeof replies]) }) as FetchLike }
    const store = new AccountStore(db, `${root}/accounts`, options)
    const id = crypto.randomUUID()
    db.query("INSERT INTO accounts (id, data) VALUES (?, ?)").run(id, JSON.stringify({ id, label: "Test", provider: "openai", createdAt: new Date().toISOString() }))
    await Bun.write(store.authFile(id), await Bun.file(authFile).text())
    const [a,b] = await Promise.all([store.refreshUsage(id), store.refreshUsage(id)])
    expect(a).toEqual(b); expect(calls).toBe(3)
    await store.close(); db.close()
    const reopened = new Database(`${root}/test.sqlite`)
    const other = new AccountStore(reopened, `${root}/accounts`, options)
    expect(other.usage(id)).toEqual(a)
    expect(other.usage("local")).toBeNull()
    await other.remove(id)
    expect(() => other.usage(id)).toThrow("no longer available")
    expect(reopened.query("SELECT * FROM account_usage").all()).toHaveLength(0)
    await other.close(); reopened.close()
})
