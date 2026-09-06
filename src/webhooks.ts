import type { Database } from "bun:sqlite"
import type { EnvironmentStore } from "./environments"

export type Webhook = { id: string, environmentId: string, name: string, port: number, path: string, enabled: boolean }
export type WebhookPayload = { url: string, method: string, headers: [string, string][], body: string }
export type WebhookReply = { status: number, headers: [string, string][], body: string }
// Self-contained so the same bounded HTTP client can run inside a Docker environment.
export async function deliverWebhook(payload: WebhookPayload): Promise<WebhookReply> {
    const response = await fetch(payload.url, { method: payload.method, headers: payload.headers, body: ["GET", "HEAD"].includes(payload.method) ? undefined : Buffer.from(payload.body, "base64"), redirect: "manual", signal: AbortSignal.timeout(10_000) })
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []
    let size = 0
    if (reader) try {
        while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > 1_000_000) throw new Error("Webhook response too large")
            chunks.push(chunk.value)
        }
    } finally { await reader.cancel() }
    return { status: response.status, headers: [...response.headers], body: Buffer.concat(chunks).toString("base64") }
}
export class WebhookStore {
    constructor(private db: Database, private environments: EnvironmentStore) { db.run("CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, data TEXT NOT NULL)") }
    list(): Webhook[] { return this.db.query<{ data: string }, []>("SELECT data FROM webhooks ORDER BY rowid").all().map(row => JSON.parse(row.data)) }
    save(value: Record<string, unknown>, id?: string): Webhook {
        const previous = id ? this.list().find(item => item.id === id) : undefined
        if (id && !previous) throw new Error("Webhook not found")
        const v = { ...previous, ...value }
        if (typeof v.environmentId !== "string") throw new Error("Choose an environment")
        this.environments.require(v.environmentId)
        if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 80) throw new Error("Name must be 1–80 characters")
        if (!Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535) throw new Error("Port must be 1–65535")
        if (typeof v.path !== "string" || !v.path.startsWith("/") || v.path.startsWith("//") || /[\\#\s]/.test(v.path) || v.path.length > 2000) throw new Error("Enter a local path such as /hooks/events")
        if (v.enabled !== undefined && typeof v.enabled !== "boolean") throw new Error("Invalid enabled setting")
        const hook: Webhook = { id: previous?.id ?? crypto.randomUUID(), name: v.name.trim(), environmentId: v.environmentId, port: Number(v.port), path: v.path, enabled: v.enabled !== false }
        this.db.query("INSERT INTO webhooks VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(hook.id, JSON.stringify(hook))
        return hook
    }
    delete(id: string) { this.db.query("DELETE FROM webhooks WHERE id=?").run(id) }
    async handle(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const hook = this.list().find(item => `/webhooks/${item.id}` === url.pathname && item.enabled)
        if (!hook) return new Response("Webhook not found", { status: 404 })
        if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return new Response("Method not allowed", { status: 405 })
        if (request.headers.get("Origin") || request.headers.get("Sec-Fetch-Site") === "cross-site") return new Response("Server-to-server requests only", { status: 403 })
        const body = await request.arrayBuffer()
        if (body.byteLength > 70_000) return new Response("Payload too large", { status: 413 })
        const destination = new URL(`http://127.0.0.1:${hook.port}${hook.path}`)
        for (const [key, value] of url.searchParams) destination.searchParams.append(key, value)
        const blocked = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "keep-alive", "te", "trailer", "proxy-authorization", "proxy-connection", "cookie", "accept-encoding"])
        for (const header of (request.headers.get("connection") ?? "").split(",")) blocked.add(header.trim().toLowerCase())
        const payload: WebhookPayload = { url: destination.href, method: request.method, headers: [...request.headers].filter(([key]) => !blocked.has(key) && !key.startsWith("x-forwarded-") && key !== "forwarded"), body: Buffer.from(body).toString("base64") }
        try {
            const reply = await this.environments.forwardWebhook(hook.environmentId, payload, request.signal)
            // Do not let an upstream service set cookies or execute content on the app's origin.
            const headers = new Headers({ "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff" })
            for (const [key, value] of reply.headers) if (["content-type", "retry-after"].includes(key.toLowerCase())) headers.set(key, value)
            return new Response(request.method === "HEAD" || [204, 205, 304].includes(reply.status) ? null : Buffer.from(reply.body, "base64"), { status: reply.status, headers })
        } catch { return new Response("Webhook destination unavailable", { status: 502 }) }
    }
}
