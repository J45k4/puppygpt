import type { ChatStore } from "./chats"
import { viewImage } from "./agent/image"

export const createChatApi = (store: ChatStore) => async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const origin = request.headers.get("Origin")
    if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        return Response.json({ error: "Only same-origin requests are allowed" }, { status: 403 })
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response("Invalid host", { status: 403 })
    try {
        const accountReply = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } })
        if (request.method === "GET" && url.pathname === "/api/accounts/local") return accountReply(await store.accounts.localAccount())
        const usageMatch = /^\/api\/accounts\/(local|[a-f0-9-]{36})\/usage(?:\/(refresh))?$/.exec(url.pathname)
        if (request.method === "GET" && usageMatch && !usageMatch[2]) return accountReply(store.accounts.usage(usageMatch[1]!))
        const accountLogin = /^\/api\/accounts\/login\/([a-f0-9-]{36})(?:\/(cancel))?$/.exec(url.pathname)
        if (request.method === "GET" && url.pathname === "/api/accounts") return accountReply(store.accounts.list())
        if (request.method === "GET" && accountLogin && !accountLogin[2]) return accountReply(store.accounts.status(accountLogin[1]!))
        const imageMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/images\/([^/]+)$/)
        if (request.method === "GET" && imageMatch) {
            const chat = store.get(imageMatch[1]!)
            const message = chat?.messages.find(message => message.id === decodeURIComponent(imageMatch[2]!))
            if (!chat || !message?.image) return new Response("Image not found", { status: 404 })
            try {
                const image = await viewImage(message.image.path, chat.cwd)
                return new Response(Buffer.from(image.imageUrl.split(",")[1]!, "base64"), {
                    headers: { "Content-Type": image.mimeType, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" },
                })
            } catch { return new Response("Image unavailable", { status: 404 }) }
        }
        if (request.method === "GET" && url.pathname === "/api/config") return Response.json(await store.config())
        if (request.method === "GET" && url.pathname === "/api/settings") return Response.json(store.settings())
        if (request.method === "GET" && url.pathname === "/api/chats") return Response.json(store.list())
        if (request.method === "GET" && url.pathname === "/api/events") {
            let unsubscribe = () => {}
            let heartbeat: ReturnType<typeof setInterval>
            let cleanup = () => {}
            const stream = new ReadableStream({
                start(controller) {
                    const encoder = new TextEncoder()
                    cleanup = () => {
                        unsubscribe()
                        clearInterval(heartbeat)
                        request.signal.removeEventListener("abort", cleanup)
                        try { controller.close() } catch {}
                    }
                    controller.enqueue(encoder.encode(": connected\n\n"))
                    unsubscribe = store.subscribe(chat => {
                        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(chat)}\n\n`)) } catch { cleanup() }
                    })
                    heartbeat = setInterval(() => {
                        try { controller.enqueue(encoder.encode(": heartbeat\n\n")) } catch { cleanup() }
                    }, 15_000)
                    request.signal.addEventListener("abort", cleanup, { once: true })
                    if (request.signal.aborted) cleanup()
                },
                cancel() { cleanup() },
            })
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" } })
        }
        const match = /^\/api\/chats\/([^/]+)(?:\/(messages|stop))?$/.exec(url.pathname)
        if (match && !store.get(match[1]!)) return Response.json({ error: "Chat not found" }, { status: 404 })
        if (request.method === "GET" && match && !match[2]) return Response.json(store.get(match[1]!))
        if (request.method === "POST") {
            if (!request.headers.get("Content-Type")?.startsWith("application/json")) return Response.json({ error: "Expected JSON" }, { status: 415 })
            const text = await request.text()
            if (text.length > 70_000) return Response.json({ error: "Message too large" }, { status: 413 })
            const body = JSON.parse(text)
            if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected a JSON object")
            if (usageMatch?.[2] === "refresh") return accountReply(await store.accounts.refreshUsage(usageMatch[1]!))
            if (url.pathname === "/api/accounts/openai/connect") {
                if (typeof body.label !== "string") throw new Error("Give this connection a name")
                return accountReply(store.accounts.start(body.label))
            }
            if (accountLogin?.[2] === "cancel") return accountReply(await store.accounts.cancel(accountLogin[1]!))
            const removeAccount = /^\/api\/accounts\/([a-f0-9-]{36})\/remove$/.exec(url.pathname)
            if (removeAccount) { await store.removeAccount(removeAccount[1]!); return accountReply({ removed: true }) }
            if (url.pathname === "/api/settings") return Response.json(await store.saveSettings(body))
            if (url.pathname === "/api/chats") {
                if (body.cwd !== undefined && typeof body.cwd !== "string") throw new Error("Invalid workspace")
                if (body.model !== undefined && typeof body.model !== "string") throw new Error("Invalid model")
                return Response.json(await store.create(body.cwd, body.model), { status: 201 })
            }
            if (match?.[2] === "messages") {
                if (typeof body.prompt !== "string") throw new Error("A message is required")
                return Response.json(store.send(match[1]!, body.prompt), { status: 202 })
            }
            if (match?.[2] === "stop") return Response.json({ stopped: store.stop(match[1]!) })
        }
        return Response.json({ error: "Not found" }, { status: 404 })
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Request failed" }, { status: 400 })
    }
}
