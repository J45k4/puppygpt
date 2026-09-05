import { serve } from "bun"
import index from "./index.html"
import { openChatStore } from "./chats"
import { createChatApi } from "./chat-api"

const store = await openChatStore()
const api = createChatApi(store)

const server = serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 60,
  maxRequestBodySize: 100_000,
  routes: { "/api/*": api, "/*": index },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
})

console.log(`Server running at ${server.url}`)
