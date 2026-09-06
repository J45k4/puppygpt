import { chatFilename, exportChat, exportChatZip } from "./chat-export"
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
        if (request.method === "GET" && url.pathname === "/api/webhooks") return Response.json(store.webhooks.list(), { headers: { "Cache-Control": "no-store" } })
        if (request.method === "GET" && url.pathname === "/api/environments") return Response.json(await store.environments.reconcileAll())
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
        if (request.method === "GET" && url.pathname === "/api/integrations") return Response.json(store.integrations.list(), { headers: { "Cache-Control": "no-store" } })
        if (request.method === "GET" && url.pathname === "/api/gpts") return Response.json(store.gpts.list())
        if (request.method === "GET" && url.pathname === "/api/config") return Response.json(await store.config())
        if (request.method === "GET" && url.pathname === "/api/settings") return Response.json(store.settings())
        if (request.method === "GET" && url.pathname === "/api/chats") return Response.json(url.searchParams.has("q") ? store.search(url.searchParams.get("q")!) : store.list())
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
        const match = /^\/api\/chats\/([^/]+)(?:\/(messages|stop|execution-target|environment|model|viewed|fork|download|compact|context))?$/.exec(url.pathname)
        if (match && !store.get(match[1]!)) return Response.json({ error: "Chat not found" }, { status: 404 })
        if (request.method === "GET" && match?.[2] === "context") return Response.json(await store.context(match[1]!), { headers: { "Cache-Control": "no-store" } })
        if (request.method === "GET" && match?.[2] === "download") {
            const chat = store.get(match[1]!)!
            const format = url.searchParams.get("format") ?? "md"
            if (!["md", "zip"].includes(format)) throw new Error("Unsupported download format")
            const archive = format === "zip"
            return new Response(archive ? await exportChatZip(structuredClone(chat), request.signal) : exportChat(chat, url.origin), { headers: {
                "Content-Type": archive ? "application/zip" : "text/markdown; charset=utf-8",
                "Content-Disposition": `attachment; filename="${archive ? chatFilename(chat).replace(/\.md$/, ".zip") : chatFilename(chat)}"`,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            } })
        }
        if (request.method === "GET" && match && !match[2]) return Response.json(store.get(match[1]!))
        if (request.method === "POST") {
            if (!request.headers.get("Content-Type")?.startsWith("application/json")) return Response.json({ error: "Expected JSON" }, { status: 415 })
            const text = await request.text()
            if (text.length > 70_000) return Response.json({ error: "Message too large" }, { status: 413 })
            const body = JSON.parse(text)
            if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected a JSON object")
            if (url.pathname === "/api/webhooks") return Response.json(store.webhooks.save(body), { status: 201 })
            const webhookMatch = /^\/api\/webhooks\/([a-f0-9-]{36})(?:\/(delete))?$/.exec(url.pathname)
            if (webhookMatch) {
                if (webhookMatch[2]) { store.webhooks.delete(webhookMatch[1]!); return Response.json({ deleted: true }) }
                return Response.json(store.webhooks.save(body, webhookMatch[1]!))
            }
            if (url.pathname === "/api/environments") {
                if (typeof body.name !== "string" || typeof body.targetId !== "string") throw new Error("Name and target are required")
                return Response.json(store.environments.create(body.name, body.targetId), { status: 201 })
            }
            const shellMatch = /^\/api\/environments\/([a-zA-Z0-9_-]+)\/shell$/.exec(url.pathname)
            if (shellMatch) {
                if (typeof body.command !== "string" || !body.command.trim()) throw new Error("A command is required")
                const id = shellMatch[1]!
                const { target } = store.environments.require(id)
                const cwd = target.kind === "docker" ? target.workspaceRoot : store.settings().cwd
                const abort = new AbortController()
                const stop = () => abort.abort()
                request.signal.addEventListener("abort", stop, { once: true })
                if (request.signal.aborted) stop()
                const stream = new ReadableStream({
                    start(controller) {
                        const encoder = new TextEncoder()
                        const send = (value: object) => { if (!abort.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(value) + "\n")) }
                        const heartbeat = setInterval(() => send({ type: "heartbeat" }), 15_000)
                        void store.environments.execute(id, { command: body.command, cwd, signal: abort.signal, onOutput: chunk => send({ type: "output", ...chunk }) })
                            .then(result => send({ type: "done", exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.liveOutputTruncated }))
                            .catch(error => send({ type: "error", message: error instanceof Error ? error.message : "Command failed" }))
                            .finally(() => { clearInterval(heartbeat); request.signal.removeEventListener("abort", stop); try { controller.close() } catch {} })
                    },
                    cancel() { stop() },
                })
                return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } })
            }
            const autoStopMatch = /^\/api\/environments\/([a-zA-Z0-9_-]+)\/auto-stop$/.exec(url.pathname)
            if (autoStopMatch) {
                if (typeof body.enabled !== "boolean") throw new Error("Choose whether auto-stop is enabled")
                return Response.json(store.environments.setAutoStop(autoStopMatch[1]!, body.enabled))
            }
            const cleanupMatch = /^\/api\/environments\/([a-zA-Z0-9_-]+)\/cleanup$/.exec(url.pathname)
            if (cleanupMatch) {
                if (typeof body.enabled !== "boolean") throw new Error("Choose whether automatic cleanup is enabled")
                return Response.json(store.environments.setCleanup(cleanupMatch[1]!, body.enabled))
            }
            const envAction = /^\/api\/environments\/([a-zA-Z0-9_-]+)\/(start|stop|delete)$/.exec(url.pathname)
            if (envAction) return Response.json(await store.environments.action(envAction[1]!, envAction[2] as "start" | "stop" | "delete"))
            if (usageMatch?.[2] === "refresh") return accountReply(await store.accounts.refreshUsage(usageMatch[1]!))
            if (url.pathname === "/api/accounts/openai/connect") {
                if (typeof body.label !== "string") throw new Error("Give this connection a name")
                return accountReply(store.accounts.start(body.label))
            }
            if (accountLogin?.[2] === "cancel") return accountReply(await store.accounts.cancel(accountLogin[1]!))
            const removeAccount = /^\/api\/accounts\/([a-f0-9-]{36})\/remove$/.exec(url.pathname)
            if (removeAccount) { await store.removeAccount(removeAccount[1]!); return accountReply({ removed: true }) }
            if (url.pathname === "/api/gpts") return Response.json(store.gpts.save(body), { status: 201 })
            const gptMatch = /^\/api\/gpts\/([a-f0-9-]{36})(?:\/(delete))?$/.exec(url.pathname)
            if (gptMatch) {
                if (gptMatch[2]) { store.gpts.delete(gptMatch[1]!); return Response.json({ deleted: true }) }
                return Response.json(store.gpts.save(body, gptMatch[1]!))
            }
            if (url.pathname === "/api/integrations") return Response.json(store.integrations.save(body), { status: 201 })
            const integrationMatch = /^\/api\/integrations\/([a-f0-9-]{36})(?:\/(test|remove))?$/.exec(url.pathname)
            if (integrationMatch) {
                const id = integrationMatch[1]!
                if (integrationMatch[2] === "test") return Response.json(await store.integrations.test(id))
                if (integrationMatch[2] === "remove") { store.integrations.remove(id); return Response.json({ removed: true }) }
                return Response.json(store.integrations.save(body, id))
            }
            if (url.pathname === "/api/settings") return Response.json(await store.saveSettings(body))
            if (url.pathname === "/api/chats") {
                if (body.gptId !== undefined && (typeof body.gptId !== "string" || !body.gptId)) throw new Error("Choose a GPT")
                if (body.cwd !== undefined && typeof body.cwd !== "string") throw new Error("Invalid workspace")
                if (body.model !== undefined && typeof body.model !== "string") throw new Error("Invalid model")
                if (body.environmentId !== undefined && typeof body.environmentId !== "string") throw new Error("Invalid environment")
                if (body.executionTarget !== undefined && typeof body.executionTarget !== "string") throw new Error("Invalid execution target")
                return Response.json(await store.create(body.cwd, body.model, body.executionTarget, body.environmentId, body.gptId), { status: 201 })
            }
            if (match?.[2] === "fork") {
                if (typeof body.messageId !== "string") throw new Error("Choose a message to fork")
                if (body.prompt !== undefined && typeof body.prompt !== "string") throw new Error("Invalid question")
                if (body.environmentId !== undefined && typeof body.environmentId !== "string") throw new Error("Invalid environment")
                if (body.cwd !== undefined && typeof body.cwd !== "string") throw new Error("Invalid workspace")
                if (body.selection !== undefined && (!body.selection || typeof body.selection !== "object" || typeof body.selection.text !== "string")) throw new Error("Invalid selection")
                return Response.json(await store.fork(match[1]!, body.messageId, body), { status: 201 })
            }
            if (match?.[2] === "viewed") {
                if (typeof body.attentionId !== "string" || !body.attentionId) throw new Error("Choose a completion to acknowledge")
                store.markViewed(match[1]!, body.attentionId)
                return Response.json({ viewed: true })
            }
            if (match?.[2] === "model") {
                if (typeof body.model !== "string") throw new Error("Choose a model")
                return Response.json(store.setModel(match[1]!, body.model))
            }
            if (match?.[2] === "environment") {
                if (typeof body.environmentId !== "string") throw new Error("Choose an environment")
                return Response.json(store.setEnvironment(match[1]!, body.environmentId))
            }
            if (match?.[2] === "execution-target") {
                if (typeof body.target !== "string" || !body.target) throw new Error("Choose an execution target")
                return Response.json(store.setExecutionTarget(match[1]!, body.target))
            }
            if (match?.[2] === "messages") {
                if (typeof body.prompt !== "string") throw new Error("A message is required")
                return Response.json(store.send(match[1]!, body.prompt), { status: 202 })
            }
            if (match?.[2] === "compact") return Response.json(store.compact(match[1]!), { status: 202 })
            if (match?.[2] === "stop") return Response.json({ stopped: store.stop(match[1]!) })
        }
        return Response.json({ error: "Not found" }, { status: 404 })
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : "Request failed" }, { status: 400 })
    }
}
