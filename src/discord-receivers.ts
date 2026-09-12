import { DiscordListener, type DiscordOptions, type DiscordStatus } from "./discord"
import type { IntegrationStore } from "./integrations"
import type { RoutingStore, SubscriptionEvent } from "./routing"

export class DiscordReceivers {
    private listeners = new Map<string, { token: string, listener: DiscordListener }>()
    private errors = new Map<string, DiscordStatus>()
    private timer?: ReturnType<typeof setInterval>
    private closing = new Set<Promise<void>>()
    constructor(private integrations: IntegrationStore, private routing: RoutingStore, private deliver: (event: SubscriptionEvent) => Promise<{ delivered: string[] }>, private options: DiscordOptions = {}) {}
    start() { this.sync(); this.timer ??= setInterval(() => this.sync(), 2000) }
    statuses(): Record<string, DiscordStatus> { return Object.fromEntries([...this.errors, ...[...this.listeners].map(([id, { listener }]) => [id, { ...listener.status }] as const)]) }
    private retire(id: string) {
        const current = this.listeners.get(id)
        if (!current) return
        this.listeners.delete(id)
        const task = current.listener.stop().finally(() => this.closing.delete(task))
        this.closing.add(task)
    }
    retry(id: string) { this.retire(id); this.sync() }
    sync() {
        const rules = this.routing.table().rules.filter(rule => rule.enabled)
        const eligible = this.integrations.list().filter(item => item.provider === "discord" && rules.some(rule => rule.source.integrationId === item.id || rule.source.integrationId === "*"))
        for (const id of this.listeners.keys()) if (!eligible.some(item => item.id === id)) this.retire(id)
        for (const id of this.errors.keys()) if (!eligible.some(item => item.id === id)) this.errors.delete(id)
        for (const item of eligible) {
            let token: string
            try { token = this.integrations.botToken(item.id); this.errors.delete(item.id) }
            catch { this.retire(item.id); this.errors.set(item.id, { state: "error", error: "Cannot read saved bot credentials. Edit the connection to replace the token.", received: 0, delivered: 0 }); continue }
            if (this.listeners.get(item.id)?.token === token) continue
            this.retire(item.id)
            const listener = new DiscordListener(item.id, token, this.deliver, this.options)
            this.listeners.set(item.id, { token, listener }); listener.start()
        }
    }
    async close() { clearInterval(this.timer); this.timer = undefined; for (const id of this.listeners.keys()) this.retire(id); await Promise.all(this.closing) }
}
