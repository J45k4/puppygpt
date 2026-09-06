import { useEffect, useState } from "react"
import type { ChatStore } from "./chats"
import { CopyMessageButton } from "./CopyMessageButton"
type Context = Awaited<ReturnType<ChatStore["context"]>>
export function ChatContextPage({ chatId, onBack }: { chatId: string, onBack: () => void }) {
    const [data, setData] = useState<Context | null>(null)
    const [error, setError] = useState("")
    const [loading, setLoading] = useState(true)
    const [revision, setRevision] = useState(0)
    const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
    useEffect(() => {
        const controller = new AbortController()
        setLoading(true); setError("")
        fetch(`/api/chats/${encodeURIComponent(chatId)}/context`, { signal: controller.signal }).then(async response => {
            const value = await response.json()
            if (!response.ok) throw new Error(value.error ?? "Could not load context")
            if (!controller.signal.aborted) setData(value)
        }).catch(error => { if (!controller.signal.aborted) setError(error.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [chatId, revision])
    return <div className="settings-scroll"><div className="context-page">
        <div className="context-heading"><h1>Chat context</h1><div><button onClick={onBack}>Back to chat</button><button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh</button></div></div>
        {error && <p className="error-banner" role="alert">{error}</p>}
        {loading && <p role="status">Loading context…</p>}
        {data && <>
            <p className="context-description">{data.title} · {data.model} · {data.reasoningEffort} reasoning</p>
            <p className="context-description">{data.source === "live" ? "Live session snapshot" : data.source === "saved" ? "Saved session snapshot" : data.source === "branch" ? "Branch starting context" : "No session context yet"}{data.snapshot?.capturedAt ? ` · ${new Date(data.snapshot.capturedAt).toLocaleString()}` : ""}{data.snapshot?.contextTokens != null ? ` · ${data.snapshot.contextTokens.toLocaleString()} tokens (last reported)` : ""}</p>
            <section className="context-section"><h2>Instructions</h2><p>Built from the current agent configuration and workspace instructions; these may differ from the last request.</p><CopyMessageButton text={data.instructions} /><pre>{data.instructions}</pre></section>
            <section className="context-section"><h2>Context items ({data.snapshot?.items.length ?? 0})</h2><p>The full retained context. Earlier turns may have been replaced by a compaction summary.</p>{data.snapshot ? <>
                <div className="context-item-actions"><CopyMessageButton text={JSON.stringify(data.snapshot, null, 2)} /><button onClick={() => setExpanded(new Set(data.snapshot!.items.map((_, index) => index)))}>Expand all</button><button onClick={() => setExpanded(new Set())}>Collapse all</button></div>
                {data.snapshot.items.map((item, index) => <details className="context-item" key={index} open={expanded.has(index)} onToggle={event => {
                    const open = event.currentTarget.open
                    setExpanded(current => {
                        if (current.has(index) === open) return current
                        const next = new Set(current)
                        if (open) next.add(index); else next.delete(index)
                        return next
                    })
                }}>
                    <summary><span className="context-item-number">{index + 1}</span><strong>{String(item.role ?? item.type ?? "Item")}</strong>{typeof item.name === "string" && <span>{item.name}</span>}</summary>
                    <CopyMessageButton text={JSON.stringify(item, null, 2)} /><pre>{JSON.stringify(item, null, 2)}</pre>
                </details>)}
            </> : <p>Send a message to begin building context.</p>}</section>
            <section className="context-section"><h2>Tool definitions</h2><CopyMessageButton text={JSON.stringify(data.tools, null, 2)} /><pre>{JSON.stringify(data.tools, null, 2)}</pre></section>
        </>}
    </div></div>
}
