import { getFreshAuth } from "./agent/auth"
import type { AgentTurnOptions } from "./agent"

export type UsageWindow = { usedPercent: number | null, seconds: number | null, resetsAt: number | null }
export type UsageLimits = { plan: string | null, windows: { name: string, primary: UsageWindow | null, secondary: UsageWindow | null }[], credits: { balance: string | null, unlimited: boolean } | null, availableResets: number | null }
export type UsageProfile = { lifetimeTokens: number | null, peakDailyTokens: number | null, longestTurnSeconds: number | null, currentStreakDays: number | null, longestStreakDays: number | null, daily: { date: string, tokens: number }[] }
export type UsageResets = { available: number | null, credits: { title: string | null, status: string | null, expiresAt: string | null }[] }
export type UsagePart<T> = { data: T | null, fetchedAt: string | null, error: string | null }
export type AccountUsage = { checkedAt: string, limits: UsagePart<UsageLimits>, profile: UsagePart<UsageProfile>, resets: UsagePart<UsageResets> }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
const str = (v: unknown) => typeof v === "string" ? v.slice(0, 300) : null
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const window = (v: unknown): UsageWindow | null => v == null ? null : { usedPercent: num(obj(v).used_percent), seconds: num(obj(v).limit_window_seconds), resetsAt: num(obj(v).reset_at) }
function limits(value: unknown): UsageLimits {
    const v = obj(value)
    if (!("plan_type" in v || "rate_limit" in v)) throw new Error("Invalid usage response")
    const group = (name: string, limit: unknown) => ({ name, primary: window(obj(limit).primary_window), secondary: window(obj(limit).secondary_window) })
    return { plan: str(v.plan_type), windows: [group("Codex", v.rate_limit), ...(v.code_review_rate_limit ? [group("Code review", v.code_review_rate_limit)] : []), ...arr(v.additional_rate_limits).map(x => group(str(obj(x).limit_name) ?? "Additional limit", obj(x).rate_limit))], credits: v.credits == null ? null : { balance: str(obj(v.credits).balance), unlimited: obj(v.credits).unlimited === true }, availableResets: num(obj(v.rate_limit_reset_credits).available_count) }
}
function profile(value: unknown): UsageProfile {
    if (!obj(value).stats || typeof obj(value).stats !== "object") throw new Error("Invalid profile response")
    const s = obj(obj(value).stats)
    return { lifetimeTokens: num(s.lifetime_tokens), peakDailyTokens: num(s.peak_daily_tokens), longestTurnSeconds: num(s.longest_running_turn_sec), currentStreakDays: num(s.current_streak_days), longestStreakDays: num(s.longest_streak_days), daily: arr(s.daily_usage_buckets).flatMap(x => { const b = obj(x); return typeof b.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.start_date) && num(b.tokens) !== null ? [{ date: b.start_date, tokens: num(b.tokens)! }] : [] }).sort((a,b) => b.date.localeCompare(a.date)) }
}
function resets(value: unknown): UsageResets {
    const v = obj(value)
    if (!("available_count" in v)) throw new Error("Invalid reset response")
    return { available: num(v.available_count), credits: arr(v.credits).map(x => ({ title: str(obj(x).title), status: str(obj(x).status), expiresAt: str(obj(x).expires_at) })) }
}
export async function fetchAccountUsage(authFile: string | undefined, options: AgentTurnOptions, previous: AccountUsage | null): Promise<AccountUsage> {
    const checkedAt = new Date().toISOString()
    let auth: Awaited<ReturnType<typeof getFreshAuth>>
    try { auth = await getFreshAuth({ authFile, authStorage: options.authStorage, fetchImpl: options.fetchImpl, issuer: options.issuer }) }
    catch { return { checkedAt, limits: { ...previous?.limits, data: previous?.limits.data ?? null, fetchedAt: previous?.limits.fetchedAt ?? null, error: "Sign in again to refresh usage." }, profile: { data: previous?.profile.data ?? null, fetchedAt: previous?.profile.fetchedAt ?? null, error: "Sign in again to refresh usage." }, resets: { data: previous?.resets.data ?? null, fetchedAt: previous?.resets.fetchedAt ?? null, error: "Sign in again to refresh usage." } } }
    async function read<T>(path: string, parse: (v: unknown) => T, old?: UsagePart<T>): Promise<UsagePart<T>> {
        try {
            const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" }
            if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId
            const response = await (options.fetchImpl ?? fetch)(`https://chatgpt.com/backend-api/wham/${path}`, { headers, signal: AbortSignal.timeout(15_000), redirect: "error" })
            if (!response.ok) return { data: old?.data ?? null, fetchedAt: old?.fetchedAt ?? null, error: `OpenAI returned ${response.status}. ${response.status === 401 ? "Sign in again." : "Try refreshing later."}` }
            return { data: parse(await response.json()), fetchedAt: new Date().toISOString(), error: null }
        } catch { return { data: old?.data ?? null, fetchedAt: old?.fetchedAt ?? null, error: "Could not fetch this data from OpenAI. Try refreshing later." } }
    }
    const [l, p, r] = await Promise.all([read("usage", limits, previous?.limits), read("profiles/me", profile, previous?.profile), read("rate-limit-reset-credits", resets, previous?.resets)])
    return { checkedAt, limits: l, profile: p, resets: r }
}
