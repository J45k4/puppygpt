import { useEffect, useState, type FormEvent } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Icon, PuppyMark } from "./Icon"
import type { AppConfig, Chat, ChatSummary } from "./chat-types"
import "./index.css"
import { readRoute, chatPath, type SettingsSection } from "./navigation"
import { SettingsPage } from "./SettingsPage"

async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined ? undefined : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? "Request failed")
    return data
}

export function App() {
    const [route, setRoute] = useState(() => readRoute(new URL(location.href), history.state))
    const settingsOpen = route.settings
    const [chats, setChats] = useState<ChatSummary[]>([])
    const [selectedId, setSelectedId] = useState<string | null>(route.chatId)
    const [chat, setChat] = useState<Chat | null>(null)
    const [config, setConfig] = useState<AppConfig | null>(null)
    const [draft, setDraft] = useState("")
    const [cwd, setCwd] = useState("")
    const [model, setModel] = useState("gpt-5.6-sol")
    const [error, setError] = useState("")
    const [sending, setSending] = useState(false)
    const [connected, setConnected] = useState(false)
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760)
    const [workspaceOpen, setWorkspaceOpen] = useState(false)
    const [filter, setFilter] = useState("")
    const [following, setFollowing] = useState(true)

    useEffect(() => {
        const sync = () => {
            const next = readRoute(new URL(location.href), history.state)
            if (next.settings || next.chatId) history.replaceState({ chatId: next.chatId }, "", next.settings ? `/settings/${next.section}` : chatPath(next.chatId))
            setRoute(next); setSelectedId(next.chatId)
        }
        sync()
        window.addEventListener("popstate", sync)
        return () => window.removeEventListener("popstate", sync)
    }, [])
    const navigate = (path: string, chatId: string | null) => {
        if (path !== location.pathname + location.search) history.pushState({ chatId }, "", path)
        setRoute(readRoute(new URL(location.href), { chatId }))
    }

    const updateChat = (incoming: Chat) => {
        setChats(previous => [incoming, ...previous.filter(item => item.id !== incoming.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    }

    useEffect(() => {
        api<AppConfig>("/api/config").then(value => { setConfig(value); setCwd(value.cwd); setModel(value.settings.model) }).catch(error => setError(error.message))
    }, [])

    useEffect(() => {
        let disposed = false
        const updates = new Map<string, Chat>()
        setChat(null)
        setFollowing(true)
        const refresh = async () => {
            try {
                const [list, current] = await Promise.all([
                    api<ChatSummary[]>("/api/chats"), selectedId ? api<Chat>(`/api/chats/${selectedId}`) : Promise.resolve(null),
                ])
                if (!disposed) {
                    setChats([...list.filter(item => !updates.has(item.id)), ...updates.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
                    setChat(selectedId ? updates.get(selectedId) ?? current : null)
                }
            } catch (error) {
                if (!disposed) setError(error instanceof Error ? error.message : "Could not load chats")
            }
        }
        const events = new EventSource("/api/events")
        events.onopen = () => { if (!disposed) { setConnected(true); void refresh() } }
        events.onerror = () => { if (!disposed) setConnected(false) }
        events.onmessage = event => {
            if (disposed) return
            const incoming: Chat = JSON.parse(event.data)
            updates.set(incoming.id, incoming)
            updateChat(incoming)
            if (incoming.id === selectedId) setChat(incoming)
        }
        return () => { disposed = true; events.close() }
    }, [selectedId])

    useEffect(() => {
        if (following) document.getElementById("conversation-end")?.scrollIntoView({ block: "end" })
    }, [chat, following])

    const select = (id: string | null) => {
        navigate(chatPath(id), id)
        setSelectedId(id)
        setDraft("")
        setError("")
        if (window.innerWidth <= 760) setSidebarOpen(false)
    }

    const openSettings = (open: boolean) => {
        navigate(open ? `/settings/${route.section}` : chatPath(selectedId), selectedId)
        if (window.innerWidth <= 760) setSidebarOpen(false)
    }

    const send = async (event: FormEvent) => {
        event.preventDefault()
        if (!draft.trim() || sending || (selectedId && !chat)) return
        setSending(true)
        setError("")
        try {
            const current = chat ?? await api<Chat>("/api/chats", { cwd, model })
            const updated = await api<Chat>(`/api/chats/${current.id}/messages`, { prompt: draft })
            updateChat(updated)
            if (selectedId !== current.id) {
                setSelectedId(current.id)
                history.replaceState({ chatId: current.id }, "", chatPath(current.id))
                setRoute(readRoute(new URL(location.href), history.state))
            }
            setChat(updated)
            setDraft("")
            setFollowing(true)
        } catch (error) {
            setError(error instanceof Error ? error.message : "Could not send message")
        } finally { setSending(false) }
    }

    const stop = async () => {
        if (!chat) return
        try { await api(`/api/chats/${chat.id}/stop`, {}) } catch (error) { setError(error instanceof Error ? error.message : "Could not stop") }
    }

    const running = chat?.status === "running"
    const path = chat?.cwd ?? cwd
    const folder = path.split("/").filter(Boolean).at(-1) ?? "workspace"
    const visibleChats = chats.filter(item => item.title.toLowerCase().includes(filter.toLowerCase()))
    const loading = !!selectedId && !chat

    return <div className={`app ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
        {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
        <aside className="sidebar" inert={!sidebarOpen} aria-hidden={!sidebarOpen}>
            <div className="brand"><PuppyMark size={29} /><span>PuppyGPT</span><button className="icon-button" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}><Icon name="panel" size={18} /></button></div>
            <button disabled={sending} className={`new-chat ${!selectedId && !settingsOpen ? "selected" : ""}`} onClick={() => select(null)}><Icon name="plus" size={18} /><span>New chat</span><kbd>Ctrl K</kbd></button>
            <div className="sidebar-section"><span>Your chats</span><span className="chat-count">{chats.length}</span></div>
            {chats.length > 5 && <label className="search"><Icon name="search" size={15} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Find a chat" aria-label="Search chats" /></label>}
            <nav className="chat-list" aria-label="Chats">
                {visibleChats.map(item => <button disabled={sending} key={item.id} className={`chat-link ${item.id === selectedId ? "active" : ""}`} onClick={() => select(item.id)} title={item.title}>
                    {item.status === "running" ? <span className="status-dot pulse" /> : <Icon name="chat" size={15} />}<span>{item.title}</span>
                    {item.status === "error" && <span className="error-dot" aria-label="Needs attention" />}
                </button>)}
                {!chats.length && <p className="sidebar-empty">A little space for your next big idea.<br />Your chats will appear here.</p>}
                {chats.length > 0 && !visibleChats.length && <p className="sidebar-empty">No matching chats.</p>}
            </nav>
            <button className={`settings-nav ${settingsOpen ? "active" : ""}`} onClick={() => openSettings(true)} aria-current={settingsOpen ? "page" : undefined}><Icon name="settings" size={18} />Settings</button>
            <div className="sidebar-bottom"><div className="local-avatar">P</div><div><strong>Personal workspace</strong><span><i className={`status-dot ${connected ? "online" : ""}`} />{connected ? "Connected locally" : "Reconnecting…"}</span></div><span className="local-badge">LOCAL</span></div>
        </aside>

        <main className="main">
            <header className="topbar"><div className="breadcrumb">{!sidebarOpen && <button className="icon-button" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Icon name="panel" /></button>}<span>{settingsOpen ? "Workspace" : selectedId ? "Chats" : "Workspace"}</span><Icon name="chevron" size={12} /><strong>{settingsOpen ? "Settings" : chat?.title ?? (loading ? "Loading…" : "New chat")}</strong></div><span className="agent-badge"><span className="status-dot online" />Local agent</span></header>

            {settingsOpen ? <SettingsPage section={route.section} onSectionChange={(section: SettingsSection) => navigate(`/settings/${section}`, selectedId)} onClose={() => openSettings(false)} onSave={settings => {
                setConfig(current => current ? { ...current, cwd: settings.cwd, settings } : current)
                void api<AppConfig>("/api/config").then(setConfig).catch(error => setError(error.message))
                setCwd(settings.cwd); setModel(settings.model)
            }} /> : <>

            <div className={`content-scroll ${!selectedId ? "welcome-scroll" : ""}`} onScroll={event => {
                const element = event.currentTarget
                setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 120)
            }}>
                {!selectedId ? <section className="welcome">
                    <div className="welcome-mark"><PuppyMark size={55} /></div>
                    <p className="eyebrow">A LITTLE HELP. A LOT OF POSSIBILITY.</p>
                    <h1>What are we working on?</h1>
                    <p className="welcome-subtitle">An idea, a question, a project. Let’s make something of it.</p>
                </section> : <div className="conversation">
                    {loading && <div className="loading"><span className="spinner" />Loading conversation</div>}
                    {chat?.messages.map(message => message.role === "activity" ? <details className="activity" key={message.id}>
                        <summary>{message.running ? <span className="spinner" /> : <Icon name="terminal" size={15} />}<span>{message.text}</span><Icon name="chevron" size={12} /></summary>
                        <pre>{message.detail ?? (message.running ? "Working…" : "Completed")}</pre>
                    </details> : <article key={message.id} className={`message ${message.role}`}>
                        {message.role === "assistant" && <div className="assistant-label"><PuppyMark size={22} /><span>PuppyGPT</span></div>}
                        {message.image && <figure className="generated-image">
                            <a href={`/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer" aria-label="Open generated image at full size">
                                <img src={`/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`} alt={message.image.prompt} loading="lazy" onLoad={() => { if (following) document.getElementById("conversation-end")?.scrollIntoView({ block: "end" }) }} />
                            </a>
                            <figcaption><a href={`/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`} download="puppygpt-image.png">Download image</a></figcaption>
                        </figure>}
                        {message.role === "error" ? <div role="alert"><strong>Couldn’t finish this turn</strong><p>{message.text}</p><span>You can send another message to continue.</span></div> : message.role === "user" ? <div className="user-bubble">{message.text}</div> : <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div>}
                    </article>)}
                    {running && <div className="working" role="status"><span className="spinner" />Working<span className="working-hint">You can add guidance below</span></div>}
                    <div id="conversation-end" />
                </div>}
            </div>

            <div className={`composer-region ${!selectedId ? "welcome-composer" : ""}`}>
                {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
                {config && !config.authAvailable && <div className="auth-notice">Sign in with Codex on this machine to connect the agent. Your chats are saved locally.</div>}
                <form className="composer" onSubmit={send}>
                    <textarea aria-label="Message" placeholder={running ? "Add guidance while PuppyGPT works…" : "Ask anything, or describe a task…"} value={draft} maxLength={64_000} rows={3} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (config?.settings.enterToSend !== false || event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
                    }} />
                    <div className="composer-toolbar"><div className="composer-options">
                        <button type="button" className="workspace-button" title={path} onClick={() => setWorkspaceOpen(!workspaceOpen)}><Icon name="folder" size={16} /><span>{folder}</span><Icon name="chevron" size={10} /></button>
                        <span className="toolbar-divider" />
                        <label className="model-picker"><span className="sr-only">Model</span><select aria-label="Model" value={chat?.model ?? model} disabled={!!selectedId} onChange={event => setModel(event.target.value)}><option value="gpt-5.6-sol">GPT-5.6 Sol</option><option value="gpt-5.6-terra">GPT-5.6 Terra</option><option value="gpt-5.6-luna">GPT-5.6 Luna</option><option value="gpt-6-astra">GPT-6 Astra</option></select></label>
                    </div><div className="send-actions">{running && <button type="button" className="stop-button" aria-label="Stop agent" onClick={stop}><Icon name="stop" size={16} /></button>}<button type="submit" className="send-button" disabled={!draft.trim() || sending || loading || !config} aria-label={running ? "Send guidance" : "Send message"}>{sending ? <span className="spinner" /> : <Icon name="arrow" size={19} />}</button></div></div>
                    {workspaceOpen && <div className="workspace-editor"><label htmlFor="workspace">Working directory</label><input id="workspace" value={path} readOnly={!!selectedId} onChange={event => setCwd(event.target.value)} /><span>{selectedId ? "Start a new chat to choose another workspace." : "The agent runs commands in this folder with your local permissions."}</span></div>}
                </form>
                {!selectedId && <div className="suggestions">{[
                    { icon: "code" as const, title: "Explore a project", prompt: "Explore this project and explain how it is structured. Don't change any files yet." },
                    { icon: "search" as const, title: "Figure something out", prompt: "Help me investigate a question. Start by asking what I would like to understand." },
                    { icon: "spark" as const, title: "Build something new", prompt: "I'd like to build something new in this workspace. Help me turn the idea into a clear first step." },
                ].map(item => <button key={item.title} onClick={() => { setDraft(item.prompt); document.querySelector<HTMLTextAreaElement>("textarea")?.focus() }}><Icon name={item.icon} size={18} /><span>{item.title}</span><Icon name="chevron" size={12} /></button>)}</div>}
                <p className="composer-footnote">{running ? "Follow-up messages guide the active turn." : config?.settings.enterToSend === false ? "Ctrl/⌘ + Enter to send · Enter for a new line" : "Enter to send · Shift + Enter for a new line"}<span>Powered by your local agent</span></p>
            </div>
            </>}
        </main>
        <KeyboardShortcuts newChat={() => { if (!sending) select(null) }} />
    </div>
}

function KeyboardShortcuts({ newChat }: { newChat: () => void }) {
    useEffect(() => {
        const listener = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "k") { event.preventDefault(); newChat() }
        }
        window.addEventListener("keydown", listener)
        return () => window.removeEventListener("keydown", listener)
    }, [newChat])
    return null
}

export default App
