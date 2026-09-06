import type { Server, ServerWebSocket, WebSocketHandler } from "bun"
import type { ChatStore } from "./chats"

export type ShellSession = { write: (data: string) => void, resize: (cols: number, rows: number) => void, close: () => Promise<void> }
export type ShellSocketData = { id: string, closed: boolean, session?: ShellSession, opening?: Promise<void> }
const sockets = new Set<ServerWebSocket<ShellSocketData>>()

export function upgradeTerminal(request: Request, server: Server<ShellSocketData>, store: ChatStore) {
    const url = new URL(request.url)
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || request.headers.get("Origin") !== url.origin || request.headers.get("Sec-Fetch-Site") === "cross-site") return new Response("Only same-origin terminals are allowed", { status: 403 })
    const id = /^\/api\/environments\/([a-zA-Z0-9_-]+)\/terminal$/.exec(url.pathname)?.[1]
    if (!id || !store.environments.get(id)) return new Response("Environment not found", { status: 404 })
    if (sockets.size >= 16) return new Response("Too many open terminals", { status: 429 })
    if (server.upgrade(request, { data: { id, closed: false } })) return
    return new Response("Expected WebSocket upgrade", { status: 400 })
}

export function terminalHandlers(store: ChatStore): WebSocketHandler<ShellSocketData> {
    return {
        maxPayloadLength: 70_000,
        idleTimeout: 120,
        sendPings: true,
        open(ws) {
            sockets.add(ws)
            ws.data.opening = (async () => {
                try {
                    const session = await store.environments.openTerminal(ws.data.id, store.settings().cwd, data => {
                        if (ws.data.closed) return
                        if (ws.getBufferedAmount() > 1_048_576) { ws.close(1013, "Terminal consumer too slow"); return }
                        ws.send(data)
                    }, code => { if (!ws.data.closed) { ws.send(JSON.stringify({ type: "exit", code })); ws.close(1000, "Shell exited") } })
                    ws.data.session = session
                    if (ws.data.closed) await session.close()
                    else ws.send(JSON.stringify({ type: "ready" }))
                } catch (error) {
                    if (!ws.data.closed) { ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Could not open terminal" })); ws.close(1011, "Terminal failed") }
                }
            })()
        },
        message(ws, raw) {
            try {
                if (typeof raw !== "string") throw new Error("Expected JSON")
                const message = JSON.parse(raw)
                if (message.type === "input" && typeof message.data === "string" && message.data.length <= 65_536) ws.data.session?.write(message.data)
                else if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows) && message.cols >= 2 && message.cols <= 400 && message.rows >= 2 && message.rows <= 200) ws.data.session?.resize(message.cols, message.rows)
                else throw new Error("Invalid terminal message")
            } catch { ws.close(1008, "Invalid terminal message") }
        },
        close(ws) {
            ws.data.closed = true
            void (async () => { await ws.data.opening; await ws.data.session?.close() })().catch(error => console.error("Terminal cleanup failed:", error)).finally(() => sockets.delete(ws))
        },
    }
}

export async function closeTerminals() {
    await Promise.all([...sockets].map(async ws => {
        ws.data.closed = true
        ws.close(1001, "Server stopping")
        await ws.data.opening
        await ws.data.session?.close()
    }))
}
