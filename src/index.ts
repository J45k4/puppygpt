import { serve } from "bun"
import index from "./index.html"
import { openChatStore } from "./chats"
import { createChatApi } from "./chat-api"

import { terminalHandlers, upgradeTerminal, closeTerminals, type ShellSocketData } from "./terminal"

const store = await openChatStore()
const api = createChatApi(store)

const server = serve<ShellSocketData>({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  maxRequestBodySize: 100_000,
  routes: { "/webhooks/*": (request: Request) => store.webhooks.handle(request), "/api/environments/:id/terminal": (request: Request, server: import("bun").Server<ShellSocketData>) => upgradeTerminal(request, server, store), "/api/*": api, "/*": index },
  websocket: terminalHandlers(store),
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
})

console.log(`Server running at ${server.url}`)

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  void closeTerminals().finally(async () => { await store.close(); await server.stop(true); process.exit(0) })
})
