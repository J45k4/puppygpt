import { useMemo, useState } from "react"
import type { ChatSummary } from "./chat-types"
import { layoutBranches } from "./branch-map"

export function BranchMap({ chats, selectedId, onOpen }: { chats: ChatSummary[], selectedId: string | null, onOpen: (id: string) => void }) {
    const [scope, setScope] = useState("all")
    const [zoom, setZoom] = useState(1)
    const [query, setQuery] = useState("")
    const roots = chats.filter(chat => !chat.parentChatId || !chats.some(parent => parent.id === chat.parentChatId))
    const visible = useMemo(() => {
        if (scope === "all") return chats
        const ids = new Set([scope])
        let changed = true
        while (changed) { changed = false; for (const chat of chats) if (chat.parentChatId && ids.has(chat.parentChatId) && !ids.has(chat.id)) { ids.add(chat.id); changed = true } }
        return chats.filter(chat => ids.has(chat.id))
    }, [chats, scope])
    const graph = useMemo(() => layoutBranches(visible), [visible])
    return <section className="branch-map-page">
        <div className="branch-map-heading"><h1>Branch map</h1><p>Explore conversations and the points where they split. Select a chat to open it.</p></div>
        <div className="branch-map-toolbar">
            <label>Conversation<select aria-label="Map conversation" value={scope} onChange={event => setScope(event.target.value)}><option value="all">All conversations</option>{roots.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
            <label>Find chat<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Highlight by title" /></label>
            <button aria-label="Zoom out" onClick={() => setZoom(value => Math.max(.4, value - .2))}>−</button><button onClick={() => setZoom(1)} aria-label="Reset map zoom">{Math.round(zoom * 100)}%</button><button aria-label="Zoom in" onClick={() => setZoom(value => Math.min(1.8, value + .2))}>+</button>
        </div>
        {!chats.length ? <p className="branch-map-empty">Your conversations will appear here. Use “Fork from here” on a message to create a branch.</p> : <div className="branch-map-scroll" tabIndex={0} aria-label="Conversation graph. Scroll to explore; tab to a chat and press Enter to open it.">
            <div style={{ width: graph.width * zoom, height: graph.height * zoom }}>
                <div className="branch-map-canvas" style={{ width: graph.width, height: graph.height, transform: `scale(${zoom})` }}>
                    <svg width={graph.width} height={graph.height} aria-hidden="true">
                        {graph.edges.map(({ from, to }) => <path key={to.chat.id} d={`M ${from.x + 272} ${from.y + 48} C ${from.x + 298} ${from.y + 48}, ${to.x - 22} ${to.y + 48}, ${to.x} ${to.y + 48}`} />)}
                    </svg>
                    {graph.nodes.map(({ chat, x, y }) => <button key={chat.id} className={`branch-map-node ${chat.id === selectedId ? "current" : ""} ${query && !chat.title.toLowerCase().includes(query.toLowerCase()) ? "dimmed" : ""}`} style={{ left: x, top: y }} onClick={() => onOpen(chat.id)} aria-label={`Open ${chat.title}${chat.parentChatId ? ", fork" : ""}`} title={`${chat.title}${chat.selection ? ` — “${chat.selection.text}”` : ""}`}>
                        <span className="branch-map-kind">{chat.parentChatId ? "↳ Fork" : "Conversation"} · {chat.status === "running" ? "Working…" : chat.status}</span>
                        <strong>{chat.title}</strong>
                        <span className="branch-map-point">{chat.selection ? `“${chat.selection.text}”` : chat.forkMessageId ? `From: ${chat.forkPreview || "earlier message"}` : "Starting point"}</span>
                    </button>)}
                </div>
            </div>
        </div>}
    </section>
}
