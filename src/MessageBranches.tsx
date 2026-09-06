import { latestChat } from "./chat-state"
import { Fragment, useEffect, useState, type FormEvent } from "react"
import { CompactionMarker, isCompactionMessage } from "./CompactionMarker"
import { ForkMarker } from "./ForkMarker"
import { CopyMessageButton } from "./CopyMessageButton"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { AppConfig, Chat, ChatMessage, ChatSummary } from "./chat-types"

async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? "Request failed")
    return result
}

function InlineBranch({ summary, onOpen, initiallyOpen }: { summary: ChatSummary, onOpen: (id: string) => void, initiallyOpen: boolean }) {
    const [open, setOpen] = useState(initiallyOpen)
    const [chat, replaceChat] = useState<Chat | null>(null)
    const setChat = (incoming: Chat) => replaceChat(current => latestChat(current, incoming))
    const [draft, setDraft] = useState("")
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    useEffect(() => {
        if (!open) return
        let disposed = false
        let updated = false
        const events = new EventSource("/api/events")
        const refresh = () => {
            updated = false
            void request<Chat>(`/api/chats/${summary.id}`).then(value => { if (!disposed && !updated) setChat(value) }).catch(error => { if (!disposed) setError(error.message) })
        }
        events.onopen = refresh
        events.onmessage = event => { const value: Chat = JSON.parse(event.data); if (!disposed && value.id === summary.id) { updated = true; setChat(value) } }
        refresh()
        return () => { disposed = true; events.close() }
    }, [open, summary.id])
    useEffect(() => {
        if (!open || chat?.status !== "running") return
        let disposed = false
        let pending = false
        const refresh = async () => {
            if (pending) return
            pending = true
            try { const current = await request<Chat>(`/api/chats/${summary.id}`); if (!disposed) setChat(current) }
            catch { /* Retry while the operation is active. */ }
            finally { pending = false }
        }
        void refresh()
        const timer = setInterval(() => { void refresh() }, 2000)
        return () => { disposed = true; clearInterval(timer) }
    }, [open, summary.id, chat?.status])
    const send = async (event: FormEvent) => {
        event.preventDefault(); setBusy(true); setError("")
        try { setChat(await request<Chat>(`/api/chats/${summary.id}/messages`, { prompt: draft })); setDraft("") }
        catch (error) { setError(error instanceof Error ? error.message : "Could not send") }
        finally { setBusy(false) }
    }
    const messages = chat?.messages ?? []
    return <details className="inline-branch" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
        <summary><span>↳ {summary.title}</span><span>{(chat?.status ?? summary.status) === "running" ? "Working…" : "Branch"}</span></summary>
        <div className="inline-branch-content">
            <button type="button" onClick={() => onOpen(summary.id)}>Open full chat ↗</button>
            {summary.selection && <blockquote>{summary.selection.text}</blockquote>}
            {!chat && !error && <p role="status">Loading branch…</p>}
            {messages.map(message => isCompactionMessage(message) ? <CompactionMarker key={message.id} message={message} /> : <Fragment key={message.id}><div className={`branch-message ${message.role}`}>
                <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "PuppyGPT" : "Activity"}</strong>
                <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
                {message.image && <img className="branch-image" src={`/api/chats/${summary.id}/images/${encodeURIComponent(message.id)}`} alt={message.image.prompt} />}
                {message.detail && <details><summary>Details</summary><pre>{message.detail}</pre></details>}
            </div>{message.id === chat?.forkMessageId && <ForkMarker onSource={() => onOpen(chat.parentChatId!)} />}</Fragment>)}
            {error && <p role="alert">{error}</p>}
            {chat && <form onSubmit={send}>
                <textarea aria-label="Reply in branch" placeholder="Continue this branch…" value={draft} onChange={event => setDraft(event.target.value)} maxLength={64000} required rows={2} />
                <button type="button" disabled={busy || chat.status === "running"} onClick={async () => {
                    setBusy(true); setError("")
                    try { setChat(await request<Chat>(`/api/chats/${summary.id}/compact`, {})) }
                    catch (error) { setError(error instanceof Error ? error.message : "Could not compact context") }
                    finally { setBusy(false) }
                }}>Compact context</button>
                <button disabled={busy || !draft.trim()}>{chat.status === "running" ? "Send guidance" : "Reply"}</button>
                {chat.status === "running" && <button type="button" onClick={() => { void request(`/api/chats/${summary.id}/stop`, {}).catch(error => setError(error.message)) }}>Stop</button>}
            </form>}
        </div>
    </details>
}

export function MessageBranches({ chat, message, chats, config, onCreated, onOpen }: {
    chat: Chat, message: ChatMessage, chats: ChatSummary[], config: AppConfig | null,
    onCreated: (chat: Chat) => void, onOpen: (id: string) => void,
}) {
    const [createdId, setCreatedId] = useState<string | null>(null)
    const [mode, setMode] = useState<"ask" | "fork" | null>(null)
    const [selection, setSelection] = useState<{ text: string, start: number, end: number } | undefined>()
    const [question, setQuestion] = useState("")
    const [environmentId, setEnvironmentId] = useState(chat.environmentId ?? "")
    const [cwd, setCwd] = useState(chat.cwd)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const children = chats.filter(child => child.parentChatId === chat.id && child.forkMessageId === message.id)
    const begin = (next: "ask" | "fork") => {
        const selected = window.getSelection()
        const article = document.getElementById(`message-${message.id}`)
        const text = selected?.toString() ?? ""
        const start = message.text.indexOf(text)
        if (text && start >= 0 && article?.contains(selected?.anchorNode ?? null) && article.contains(selected?.focusNode ?? null)) setSelection({ text, start, end: start + text.length })
        else setSelection(undefined)
        setMode(next); setError("")
    }
    const submit = async (event: FormEvent) => {
        event.preventDefault(); setBusy(true); setError("")
        try {
            const branch = await request<Chat>(`/api/chats/${chat.id}/fork`, { messageId: message.id, selection, ...(mode === "ask" ? { prompt: question } : { environmentId, cwd }) })
            setCreatedId(branch.id); onCreated(branch); setMode(null); setQuestion("")
            if (mode === "fork") onOpen(branch.id)
        } catch (error) { setError(error instanceof Error ? error.message : "Could not create branch") }
        finally { setBusy(false) }
    }
    return <div className="message-branches">
        <div className="message-actions">
            <CopyMessageButton text={message.text || message.image?.prompt || ""} />
            <button type="button" disabled={chat.status === "running"} onMouseDown={event => event.preventDefault()} onClick={() => begin("ask")}>Ask about this</button>
            <button type="button" disabled={chat.status === "running"} onClick={() => begin("fork")}>Fork from here</button>
            {chat.status === "running" && <span>Available when this turn finishes</span>}
        </div>
        {mode && <form className="branch-form" onSubmit={submit}>
            {mode === "fork" && <>
                <strong>Fork this conversation</strong>
                <label>Environment<select value={environmentId} onChange={event => setEnvironmentId(event.target.value)}>{config?.execution.environments.map(environment => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
                <label>Workspace folder<input value={cwd} required onChange={event => setCwd(event.target.value)} /></label>
            </>}
            {selection && <blockquote>{selection.text}</blockquote>}
            {mode === "ask" && <textarea autoFocus required aria-label="Question about this message" placeholder="Ask about this…" value={question} maxLength={32000} rows={2} onChange={event => setQuestion(event.target.value)} onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
                if (event.key === "Escape" && !busy) setMode(null)
            }} />}
            {error && <p role="alert">{error}</p>}
            <div><button disabled={busy || (mode === "fork" && !config) || (mode === "ask" && !question.trim())}>{busy ? "Creating…" : mode === "ask" ? "Send" : "Create fork"}</button><button type="button" disabled={busy} onClick={() => setMode(null)}>Cancel</button></div>
        </form>}
        {children.map(child => <InlineBranch key={child.id} summary={child} onOpen={onOpen} initiallyOpen={child.id === createdId} />)}
    </div>
}
