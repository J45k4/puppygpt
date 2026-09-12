import type { SubscriptionEvent } from "./routing"

export type DiscordStatus = { state: "connecting" | "connected" | "reconnecting" | "error" | "stopped", error?: string, received: number, delivered: number, lastReceivedAt?: string }
type Message = { id?: string, channel_id?: string, guild_id?: string, content?: string, webhook_id?: string, author?: { id?: string, bot?: boolean, username?: string, global_name?: string }, attachments?: { filename?: string }[] }
export function discordEvent(integrationId: string, message: Message): SubscriptionEvent | null {
    if (!message?.id || !message.channel_id || !message.author?.id || message.author.bot || message.webhook_id) return null
    const text = message.content?.trim() || (message.attachments?.length ? `[Attachments: ${message.attachments.map(item => item.filename ?? "file").join(", ")}]` : "[Discord message without text]")
    return {
        event: { id: message.id, type: "message.created", provider: "discord", integrationId },
        sender: { id: message.author.id, ...(message.author.username ? { username: message.author.username } : {}), ...(message.author.global_name ? { name: message.author.global_name } : {}) },
        conversation: { id: message.channel_id, type: message.guild_id ? "guild" : "direct" },
        message: { id: message.id, text: text.slice(0, 4000) },
    }
}

// Only Discord-owned Gateway URLs may receive the bot token, including on resume.
function gatewayUrl(value: string) {
    const url = new URL(value)
    if (url.protocol !== "wss:" || !(url.hostname === "gateway.discord.gg" || url.hostname.endsWith(".discord.gg")) || url.username || url.password || url.port) throw new Error("Invalid Gateway URL")
    url.search = "?v=10&encoding=json"
    return url.href
}
export type DiscordOptions = { fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>, socket?: (url: string) => WebSocket, retryMs?: number, random?: () => number }
export class DiscordListener {
    private ws?: WebSocket
    private heartbeat?: ReturnType<typeof setTimeout>
    private reconnect?: ReturnType<typeof setTimeout>
    private handshake?: ReturnType<typeof setTimeout>
    private stopped = false
    private acknowledged = true
    private sequence: number | null = null
    private session?: string
    private resumeUrl?: string
    private url?: string
    private attempt = 0
    private seen = new Set<string>()
    private queue: Promise<void> = Promise.resolve()
    private pending = 0
    private abort = new AbortController()
    readonly status: DiscordStatus = { state: "connecting", received: 0, delivered: 0 }
    constructor(private integrationId: string, private token: string, private deliver: (event: SubscriptionEvent) => Promise<{ delivered: string[] }>, private options: DiscordOptions = {}) {}
    start() { void this.connect() }
    private async connect() {
        if (this.stopped) return
        try {
            if (!this.url) {
                const response = await (this.options.fetchImpl ?? fetch)("https://discord.com/api/v10/gateway", { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]), redirect: "error" })
                if (!response.ok) throw new Error()
                this.url = gatewayUrl((await response.json()).url)
            }
            if (this.stopped) return
            const ws = this.ws = (this.options.socket ?? (url => new WebSocket(url)))(this.resumeUrl ?? this.url)
            this.handshake = setTimeout(() => this.retry(), 30000)
            ws.onmessage = event => {
                if (this.ws !== ws || this.stopped) return
                try { this.packet(JSON.parse(String(event.data))) } catch { this.retry() }
            }
            ws.onerror = () => { if (this.ws === ws) this.retry() }
            ws.onclose = event => {
                if (this.ws !== ws || this.stopped) return
                if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code)) {
                    this.status.state = "error"
                    this.status.error = event.code === 4014 ? "Enable Message Content Intent in Discord Developer Portal → Bot, then retry the listener." : event.code === 4004 ? "Discord rejected the bot token. Edit the connection to replace it." : `Discord rejected the Gateway connection (code ${event.code}).`
                    this.disconnect(); return
                }
                if ([4007, 4009].includes(event.code)) this.resetSession()
                this.retry()
            }
        } catch { if (!this.stopped) this.retry() }
    }
    private send(op: number, d: unknown) { this.ws?.send(JSON.stringify({ op, d })) }
    private packet(packet: { op: number, s?: number, t?: string, d: any }) {
        if (typeof packet.s === "number") this.sequence = packet.s
        if (packet.op === 10) {
            const interval = packet.d?.heartbeat_interval
            if (!Number.isFinite(interval) || interval < 1) throw new Error()
            clearTimeout(this.heartbeat)
            this.acknowledged = true
            const beat = () => {
                if (!this.acknowledged) { this.retry(); return }
                try { this.acknowledged = false; this.send(1, this.sequence) } catch { this.retry(); return }
                this.heartbeat = setTimeout(beat, interval)
            }
            this.heartbeat = setTimeout(beat, interval * (this.options.random ?? Math.random)())
            if (this.session && this.sequence !== null) this.send(6, { token: this.token, session_id: this.session, seq: this.sequence })
            else this.send(2, { token: this.token, intents: (1 << 9) | (1 << 12) | (1 << 15), properties: { os: process.platform, browser: "PuppyGPT", device: "PuppyGPT" } })
        } else if (packet.op === 11) this.acknowledged = true
        else if (packet.op === 1) this.send(1, this.sequence)
        else if (packet.op === 7) this.retry()
        else if (packet.op === 9) { if (!packet.d) this.resetSession(); this.retry() }
        else if (packet.op === 0) {
            if (packet.t === "READY" || packet.t === "RESUMED") {
                if (packet.t === "READY") { this.session = packet.d.session_id; this.resumeUrl = gatewayUrl(packet.d.resume_gateway_url) }
                clearTimeout(this.handshake); this.attempt = 0; this.status.state = "connected"; delete this.status.error
            } else if (packet.t === "MESSAGE_CREATE") {
                const event = discordEvent(this.integrationId, packet.d)
                if (!event || this.seen.has(event.event.id)) return
                if (this.pending >= 500) { this.status.error = "Incoming message queue is full; a message was dropped."; return }
                this.seen.add(event.event.id)
                if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!)
                this.status.received++; this.status.lastReceivedAt = new Date().toISOString(); this.pending++
                this.queue = this.queue.then(async () => {
                    if (this.stopped) return
                    try { const result = await this.deliver(event); this.status.delivered += result.delivered.length; delete this.status.error }
                    catch { this.status.error = "Could not route an incoming Discord message. Check the destination chat and routing rules." }
                }).finally(() => { this.pending-- })
            }
        }
    }
    private resetSession() { this.session = undefined; this.resumeUrl = undefined; this.sequence = null }
    private disconnect() {
        clearTimeout(this.heartbeat); clearTimeout(this.handshake)
        const ws = this.ws; this.ws = undefined
        if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(4000, "Reconnecting or stopping") }
    }
    private retry() {
        if (this.stopped) return
        this.disconnect(); clearTimeout(this.reconnect)
        this.status.state = "reconnecting"
        const delay = this.options.retryMs ?? Math.min(60000, 5000 * 2 ** Math.min(this.attempt++, 4)) + Math.random() * 1000
        this.reconnect = setTimeout(() => { void this.connect() }, delay)
    }
    async stop() { this.stopped = true; this.abort.abort(); clearTimeout(this.reconnect); this.disconnect(); this.status.state = "stopped"; await this.queue }
    async settled() { await this.queue }
}
