import type { ChatMessage } from "../chat-types"
import { Icon } from "./Icon"

export function messageOrigin(message: Pick<ChatMessage, "text" | "detail">) {
    const match = /<subscription_event>\s*([\s\S]*?)\s*<\/subscription_event>/.exec(message.detail ?? "")
    if (!match) return null
    try {
        const event = JSON.parse(match[1]!)
        if (typeof event.event?.provider !== "string") return null
        const provider: string = event.event.provider
        const sender = event.sender?.name ?? event.sender?.username ?? event.sender?.id
        const channel = event.conversation?.id
        const prefix = [provider, sender, channel ? `channel ${channel}` : undefined].filter(Boolean).join(" · ") + "\n"
        return { provider, sender: typeof sender === "string" ? sender : undefined, channel: typeof channel === "string" ? channel : undefined, text: message.text.startsWith(prefix) ? message.text.slice(prefix.length) : message.text }
    } catch { return null }
}
function SourceIcon({ provider }: { provider: string }) {
    if (provider === "discord") return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.7 5.2a18 18 0 0 0-4.4-1.4l-.5 1a16 16 0 0 0-5.6 0l-.5-1a18 18 0 0 0-4.4 1.4C1.5 9.4.8 13.5 1.2 17.5a18 18 0 0 0 5.4 2.7l1.1-1.8-1.7-.8.4-.3a16 16 0 0 0 11.2 0l.4.3-1.7.8 1.1 1.8a18 18 0 0 0 5.4-2.7c.5-4.6-.8-8.6-3.1-12.3ZM8.5 14.8c-1 0-1.8-1-1.8-2.2s.8-2.2 1.8-2.2 1.8 1 1.8 2.2-.8 2.2-1.8 2.2Zm7 0c-1 0-1.8-1-1.8-2.2s.8-2.2 1.8-2.2 1.8 1 1.8 2.2-.8 2.2-1.8 2.2Z" /></svg>
    if (provider === "telegram") return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 18-7-4 18-6-6-4 3v-6Zm4 2 10-6-6 9" /></svg>
    return <Icon name="plug" size={16} />
}
export function IncomingMessage({ message }: { message: ChatMessage }) {
    const origin = messageOrigin(message)
    return <>
        {origin && <div className="message-origin" title={origin.channel ? `Channel ${origin.channel}` : undefined}>
            <span className={`message-origin-service ${origin.provider === "discord" ? "discord" : origin.provider === "telegram" ? "telegram" : ""}`}><SourceIcon provider={origin.provider} /><span>{origin.provider === "discord" ? "Discord" : origin.provider === "telegram" ? "Telegram" : origin.provider}</span></span>
            {origin.sender && <span className="message-origin-sender">{origin.sender}</span>}
        </div>}
        <div className="user-bubble">{origin?.text ?? message.text}</div>
    </>
}
