export const settingsSections = ["accounts", "integrations", "preferences", "agent"] as const
export type SettingsSection = typeof settingsSections[number]
export function readRoute(url: URL, state: unknown = null) {
    const map = /^\/map\/?$/.test(url.pathname)
    const profile = /^\/profile\/?$/.test(url.pathname)
    const gpts = /^\/gpts\/?$/.test(url.pathname)
    const environmentMatch = /^\/environments(?:\/([a-zA-Z0-9_-]+))?\/?$/.exec(url.pathname)
    const environments = !!environmentMatch
    const environmentId = environmentMatch?.[1] ?? null
    const settings = url.pathname === "/settings" || url.pathname.startsWith("/settings/") || url.searchParams.get("settings") === "1"
    const candidate = url.pathname.startsWith("/settings/") ? url.pathname.split("/")[2] : url.searchParams.get("section")
    const section = settingsSections.find(section => section === candidate) ?? "accounts"
    const savedChat = state && typeof state === "object" && "chatId" in state && typeof state.chatId === "string" ? state.chatId : null
    const match = /^\/chat\/([^/]+)(?:\/(context))?\/?$/.exec(url.pathname)
    let pathChat: string | null = null
    if (match) { try { pathChat = decodeURIComponent(match[1]!) } catch {} }
    const chatId = pathChat ?? url.searchParams.get("chat") ?? (settings || environments || gpts || profile || map ? savedChat : null)
    return { context: !!match?.[2], map, profile, gpts, settings, environments, environmentId, section, chatId }
}
export function chatPath(id: string | null) { return id ? `/chat/${encodeURIComponent(id)}` : "/" }
