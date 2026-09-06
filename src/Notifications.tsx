import { useEffect, useRef, useState } from "react"
import type { ChatSummary } from "./chat-types"
import { Icon } from "./Icon"

export function Notifications({ chats, disabled, onSelect }: { chats: ChatSummary[], disabled: boolean, onSelect: (id: string) => void }) {
    const [open, setOpen] = useState(false)
    const root = useRef<HTMLDivElement>(null)
    const button = useRef<HTMLButtonElement>(null)
    const notifications = chats.filter(chat => chat.attentionId && chat.status !== "running")
    useEffect(() => {
        if (!open) return
        const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
        const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus() } }
        document.addEventListener("pointerdown", outside)
        document.addEventListener("keydown", escape)
        return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape) }
    }, [open])
    return <div className="notifications" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
        <button ref={button} className="icon-button notification-bell" aria-label={`Notifications${notifications.length ? `, ${notifications.length} unread` : ""}`} title="Notifications" aria-expanded={open} aria-controls="notifications-panel" onClick={() => setOpen(value => !value)}>
            <Icon name="bell" size={20} />
            {notifications.length > 0 && <span className="notification-count" aria-hidden="true">{notifications.length > 99 ? "99+" : notifications.length}</span>}
        </button>
        {open && <section id="notifications-panel" className="notifications-panel" aria-label="Notifications">
            <div className="notifications-heading"><strong>Notifications</strong><span>{notifications.length} unread</span></div>
            {notifications.length ? <ul className="notification-list">{notifications.map(chat => <li key={chat.id}>
                <button disabled={disabled} className="notification-item" onClick={() => { setOpen(false); onSelect(chat.id) }}>
                    <span className="notification-indicator" />
                    <span className="notification-copy"><strong>{chat.title}</strong><span>{chat.attentionReason ? `${chat.attentionReason} · Needs attention` : chat.status === "error" ? "Couldn’t finish · Needs attention" : "Work finished · Needs attention"}</span><time dateTime={chat.updatedAt}>{new Date(chat.updatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></span>
                    <Icon name="chevron" size={15} />
                </button>
            </li>)}</ul> : <p className="notifications-empty">You’re all caught up.<span>New activity needing your attention will appear here.</span></p>}
        </section>}
    </div>
}
