import { ChatContextPage } from "./ChatContextPage"
import { latestChat } from "./chat-state"
import { DownloadChatButton } from "./DownloadChatButton"
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Icon, PuppyMark } from "./Icon"
import type { AppConfig, Chat, ChatSummary } from "./chat-types"
import "./index.css"
import { readRoute, chatPath, type SettingsSection } from "./navigation"
import { EnvironmentsPage } from "./EnvironmentsPage"
import { CopyMessageButton } from "./CopyMessageButton"
import { ProfilePage } from "./ProfilePage"
import { GptsPage } from "./GptsPage"
import { Notifications } from "./Notifications"
import { BranchMap } from "./BranchMap"
import { CompactionMarker, isCompactionMessage } from "./CompactionMarker"
import { ForkMarker } from "./ForkMarker"
import { MessageBranches } from "./MessageBranches"
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
    const mapOpen = route.map
    const settingsOpen = route.settings
    const gptsOpen = route.gpts
    const profileOpen = route.profile
    const contextOpen = route.context
    const [chats, setChats] = useState<ChatSummary[]>([])
    const [selectedId, setSelectedId] = useState<string | null>(route.chatId)
    const [chat, replaceChat] = useState<Chat | null>(null)
    const setChat = (value: Chat | null | ((current: Chat | null) => Chat | null)) => replaceChat(current => {
        const incoming = typeof value === "function" ? value(current) : value
        return incoming ? latestChat(current, incoming) : null
    })
    const [config, setConfig] = useState<AppConfig | null>(null)
    const [draft, setDraft] = useState("")
    const [cwd, setCwd] = useState("")
    const environmentsOpen = route.environments
    const [executionTarget, setExecutionTarget] = useState("")
    const [changingTarget, setChangingTarget] = useState(false)
    const [model, setModel] = useState("gpt-6-astra")
    const [error, setError] = useState("")
    const [sending, setSending] = useState(false)
    const [connected, setConnected] = useState(false)
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760)
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        try { const saved = Number(localStorage.getItem("puppygpt.sidebarWidth")); return saved >= 220 && saved <= 520 ? saved : 252 } catch { return 252 }
    })
    const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
    const sidebarMax = Math.max(220, Math.min(520, viewportWidth - 360))
    const actualSidebarWidth = Math.min(sidebarWidth, sidebarMax)
    const sidebarDrag = useRef<{ x: number, width: number } | null>(null)
    const [resizingSidebar, setResizingSidebar] = useState(false)
    const resizeSidebar = (width: number) => setSidebarWidth(Math.max(220, Math.min(sidebarMax, width)))
    useEffect(() => {
        const resize = () => setViewportWidth(window.innerWidth)
        window.addEventListener("resize", resize)
        return () => window.removeEventListener("resize", resize)
    }, [])
    useEffect(() => { try { localStorage.setItem("puppygpt.sidebarWidth", String(sidebarWidth)) } catch {} }, [sidebarWidth])
    const [workspaceOpen, setWorkspaceOpen] = useState(false)
    const [filter, setFilter] = useState("")
    const [searchResult, setSearchResult] = useState<{ query: string, chats: ChatSummary[] } | null>(null)
    const [searchError, setSearchError] = useState("")
    const [searching, setSearching] = useState(false)
    const [following, setFollowing] = useState(true)

    useEffect(() => {
        const sync = () => {
            const next = readRoute(new URL(location.href), history.state)
            if (next.map || next.profile || next.gpts || next.settings || next.environments || next.chatId) history.replaceState({ chatId: next.chatId }, "", next.map ? "/map" : next.profile ? "/profile" : next.gpts ? "/gpts" : next.environments ? `/environments${next.environmentId ? `/${next.environmentId}` : ""}` : next.settings ? `/settings/${next.section}` : next.context ? `${chatPath(next.chatId)}/context` : chatPath(next.chatId))
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
        setChats(previous => [latestChat(previous.find(item => item.id === incoming.id) ?? null, incoming), ...previous.filter(item => item.id !== incoming.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    }

    useEffect(() => {
        api<AppConfig>("/api/config").then(value => { setConfig(value); setCwd(value.cwd); setModel(value.settings.model); setExecutionTarget("") }).catch(error => setError(error.message))
    }, [])

    useEffect(() => {
        let disposed = false
        const updates = new Map<string, Chat>()
        setChat(null)
        setFollowing(true)
        const refresh = async () => {
            updates.clear()
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
        if (!selectedId || chat?.status !== "running") return
        let disposed = false
        let pending = false
        const reconcile = async () => {
            if (pending) return
            pending = true
            try {
                const current = await api<Chat>(`/api/chats/${selectedId}`)
                if (!disposed) { setChat(current); updateChat(current) }
            } catch { /* SSE reconnect and the next poll will retry. */ }
            finally { pending = false }
        }
        void reconcile()
        const timer = setInterval(() => { void reconcile() }, 2000)
        return () => { disposed = true; clearInterval(timer) }
    }, [selectedId, chat?.status])

    useEffect(() => {
        if (following) document.getElementById("conversation-end")?.scrollIntoView({ block: "end" })
    }, [chat, following])

    useEffect(() => {
        const attentionId = chat?.attentionId
        const id = chat?.id
        if (!id || id !== selectedId || !attentionId || chat.status === "running" || settingsOpen || environmentsOpen || gptsOpen || profileOpen || mapOpen || contextOpen) return
        let pending = false
        let disposed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const schedule = () => {
            clearTimeout(timer)
            if (document.visibilityState !== "visible" || !document.hasFocus()) return
            timer = setTimeout(() => {
                if (disposed || pending || document.visibilityState !== "visible" || !document.hasFocus()) return
                pending = true
                void api(`/api/chats/${id}/viewed`, { attentionId }).then(() => {
                    if (disposed) return
                    const clear = <T extends ChatSummary,>(item: T): T => item.id === id && item.attentionId === attentionId ? { ...item, attentionId: undefined } : item
                    setChats(items => items.map(clear))
                    setChat(current => current ? clear(current) : current)
                }).catch(() => {}).finally(() => { pending = false })
            }, 500)
        }
        schedule()
        window.addEventListener("focus", schedule)
        window.addEventListener("blur", schedule)
        document.addEventListener("visibilitychange", schedule)
        return () => { disposed = true; clearTimeout(timer); window.removeEventListener("focus", schedule); window.removeEventListener("blur", schedule); document.removeEventListener("visibilitychange", schedule) }
    }, [chat?.id, chat?.attentionId, chat?.status, selectedId, settingsOpen, environmentsOpen, gptsOpen, profileOpen, mapOpen, contextOpen, connected])

    const searchRevision = chats.map(chat => `${chat.id}:${chat.updatedAt}:${chat.status}:${chat.attentionId ?? ""}`).join("|")
    useEffect(() => {
        const query = filter.trim()
        if (!query) { setSearchResult(null); setSearching(false); setSearchError(""); return }
        const controller = new AbortController()
        setSearching(true); setSearchError("")
        const timer = setTimeout(async () => {
            try {
                const response = await fetch(`/api/chats?q=${encodeURIComponent(query)}`, { signal: controller.signal })
                const data = await response.json()
                if (!response.ok) throw new Error(data.error ?? "Search failed")
                if (!controller.signal.aborted) setSearchResult({ query, chats: data })
            } catch (error) {
                if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : "Search failed")
            } finally { if (!controller.signal.aborted) setSearching(false) }
        }, 250)
        return () => { clearTimeout(timer); controller.abort() }
    }, [filter, searchRevision])

    const select = (id: string | null) => {
        navigate(chatPath(id), id)
        setSelectedId(id)
        setDraft("")
        setError("")
        if (window.innerWidth <= 760) setSidebarOpen(false)
    }

    const breadcrumbLink = (label: string, path: string) => <a href={path} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        if (path === "/") select(null)
        else if (path === chatPath(selectedId)) select(selectedId)
        else navigate(path, selectedId)
    }}>{label}</a>

    const openSettings = (open: boolean) => {
        navigate(open ? `/settings/${route.section}` : chatPath(selectedId), selectedId)
        if (window.innerWidth <= 760) setSidebarOpen(false)
    }

    const openEnvironments = () => {
        navigate("/environments", selectedId)
        if (window.innerWidth <= 760) setSidebarOpen(false)
    }

    const send = async (event: FormEvent) => {
        event.preventDefault()
        if (!draft.trim() || sending || changingTarget || (selectedId && !chat)) return
        setSending(true)
        setError("")
        try {
            const current = chat ?? await api<Chat>("/api/chats", { cwd, model, executionTarget: executionTarget || undefined })
            if (!chat) {
                setChat(current); setSelectedId(current.id); updateChat(current)
                history.replaceState({ chatId: current.id }, "", chatPath(current.id))
                setRoute(readRoute(new URL(location.href), history.state))
                void api<AppConfig>("/api/config").then(setConfig)
            }
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

    const changeModel = async (value: string) => {
        if (!selectedId) { setModel(value); return }
        setChangingTarget(true); setError("")
        try {
            const updated = await api<Chat>(`/api/chats/${selectedId}/model`, { model: value })
            setChat(updated); updateChat(updated)
        } catch (error) { setError(error instanceof Error ? error.message : "Could not change model") }
        finally { setChangingTarget(false) }
    }

    const changeExecutionTarget = async (target: string) => {
        if (!selectedId) { setExecutionTarget(target); return }
        setChangingTarget(true); setError("")
        try {
            const updated = await api<Chat>(`/api/chats/${selectedId}/environment`, { environmentId: target })
            setChat(updated); updateChat(updated)
        } catch (error) { setError(error instanceof Error ? error.message : "Could not change execution target") }
        finally { setChangingTarget(false) }
    }

    const compact = async () => {
        if (!chat || sending || chat.status === "running") return
        setSending(true); setError("")
        try {
            const updated = await api<Chat>(`/api/chats/${chat.id}/compact`, {})
            setChat(updated); updateChat(updated); setFollowing(true)
        } catch (error) { setError(error instanceof Error ? error.message : "Could not compact context") }
        finally { setSending(false) }
    }

    const stop = async () => {
        if (!chat) return
        try { await api(`/api/chats/${chat.id}/stop`, {}) } catch (error) { setError(error instanceof Error ? error.message : "Could not stop") }
    }

    const running = chat?.status === "running"
    const path = chat?.cwd ?? cwd
    const folder = path.split("/").filter(Boolean).at(-1) ?? "workspace"
    const visibleChats = filter.trim() ? searchResult?.query === filter.trim() ? searchResult.chats : [] : chats
    const loading = !!selectedId && !chat

    return <div className={`app ${sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${resizingSidebar ? "sidebar-resizing" : ""}`} style={{ "--sidebar-width": `${actualSidebarWidth}px` } as CSSProperties}>
        {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
        <aside className="sidebar" inert={!sidebarOpen} aria-hidden={!sidebarOpen}>
            <div className="brand"><PuppyMark size={29} /><span>PuppyGPT</span><button className="icon-button" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)}><Icon name="panel" size={18} /></button></div>
            <label className="search"><Icon name="search" size={15} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Search titles and messages" maxLength={500} aria-label="Search chats" /></label>
            <div className="sidebar-section"><span className="sidebar-section-title">Your chats <span className="chat-count">{chats.length}</span></span><button disabled={sending || changingTarget} className="icon-button" onClick={() => select(null)} aria-label="New chat" title="New chat (Ctrl K)"><Icon name="plus" size={18} /></button></div>
            <nav className="chat-list" aria-label="Chats">
                {visibleChats.map(item => <button disabled={sending || changingTarget} key={item.id} className={`chat-link ${item.id === selectedId ? "active" : ""}`} onClick={() => select(item.id)} title={item.title}>
                    {item.status === "running" ? <span className="spinner" role="status" aria-label="Working" title="Working" /> : <Icon name="chat" size={15} />}<span>{item.title}</span>
                    {item.attentionId && item.status !== "running" && <span className="error-dot" aria-label="Needs attention" title="Needs attention — new activity" />}
                </button>)}
                {!chats.length && <p className="sidebar-empty">A little space for your next big idea.<br />Your chats will appear here.</p>}
                {filter.trim() && searching && <p className="sidebar-empty" role="status">Searching…</p>}
                {filter.trim() && searchError && <p className="sidebar-empty" role="alert">{searchError}</p>}
                {chats.length > 0 && !visibleChats.length && !searching && !searchError && <p className="sidebar-empty">No matching chats.</p>}
            </nav>
            <button className={`settings-nav ${mapOpen ? "active" : ""}`} onClick={() => { navigate("/map", selectedId); if (window.innerWidth <= 760) setSidebarOpen(false) }} aria-current={mapOpen ? "page" : undefined}><Icon name="chat" size={18} />Branch map</button>
            <button disabled={sending || changingTarget} className={`settings-nav ${gptsOpen ? "active" : ""}`} onClick={() => { navigate("/gpts", selectedId); if (window.innerWidth <= 760) setSidebarOpen(false) }} aria-current={gptsOpen ? "page" : undefined}><Icon name="spark" size={18} />GPTs</button>
            <button disabled={!config} className={`settings-nav ${environmentsOpen ? "active" : ""}`} onClick={openEnvironments} aria-current={environmentsOpen ? "page" : undefined}><Icon name="terminal" size={18} />Environments</button>
            <button disabled={changingTarget} className={`settings-nav ${settingsOpen ? "active" : ""}`} onClick={() => openSettings(true)} aria-current={settingsOpen ? "page" : undefined}><Icon name="settings" size={18} />Settings</button>

            <div className="sidebar-resize" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={sidebarMax} aria-valuenow={actualSidebarWidth} tabIndex={sidebarOpen ? 0 : -1}
                title="Drag to resize · Arrow keys to adjust · Double-click to reset"
                onPointerDown={event => {
                    if (event.button !== 0) return
                    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
                    sidebarDrag.current = { x: event.clientX, width: actualSidebarWidth }; setResizingSidebar(true)
                }}
                onPointerMove={event => { if (sidebarDrag.current) resizeSidebar(sidebarDrag.current.width + event.clientX - sidebarDrag.current.x) }}
                onPointerUp={event => { sidebarDrag.current = null; setResizingSidebar(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
                onPointerCancel={() => { sidebarDrag.current = null; setResizingSidebar(false) }}
                onLostPointerCapture={() => { sidebarDrag.current = null; setResizingSidebar(false) }}
                onDoubleClick={() => resizeSidebar(252)}
                onKeyDown={event => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
                    event.preventDefault()
                    resizeSidebar(event.key === "Home" ? 220 : event.key === "End" ? sidebarMax : actualSidebarWidth + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 10))
                }} />
        </aside>

        <main className="main">
            <header className="topbar"><nav className="breadcrumb" aria-label="Breadcrumb">
                {!sidebarOpen && <button className="icon-button" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Icon name="panel" /></button>}
                {breadcrumbLink(settingsOpen || environmentsOpen || gptsOpen || profileOpen || mapOpen || !selectedId ? "Workspace" : "Chats", "/")}
                <Icon name="chevron" size={12} />
                {environmentsOpen && route.environmentId ? <>
                    {breadcrumbLink("Environments", "/environments")}<Icon name="chevron" size={12} />
                    <strong aria-current="page">{route.environmentId === "new" ? "New environment" : config?.execution.environments.find(environment => environment.id === route.environmentId)?.name ?? "Environment"}</strong>
                </> : contextOpen ? <>
                    {breadcrumbLink(chat?.title ?? "Chat", chatPath(selectedId))}<Icon name="chevron" size={12} />
                    <strong aria-current="page">Context</strong>
                </> : <strong aria-current="page">{mapOpen ? "Branch map" : profileOpen ? "Profile" : gptsOpen ? "GPTs" : environmentsOpen ? "Environments" : settingsOpen ? "Settings" : chat?.title ?? (loading ? "Loading…" : "New chat")}</strong>}
            </nav><div className="topbar-actions">{chat && !settingsOpen && !environmentsOpen && !gptsOpen && !profileOpen && !mapOpen && <><button className="icon-button" aria-label="View chat context" title="View chat context" onClick={() => navigate(`${chatPath(chat.id)}/context`, chat.id)}><Icon name="code" size={20} /></button><DownloadChatButton key={chat.id} chat={chat} /></>}<Notifications chats={chats} disabled={sending || changingTarget} onSelect={select} /><button className="local-avatar" aria-label="Open profile" title="Profile" aria-current={profileOpen ? "page" : undefined} onClick={() => { navigate("/profile", selectedId); if (window.innerWidth <= 760) setSidebarOpen(false) }}>P</button></div></header>

            {contextOpen && selectedId ? <ChatContextPage key={selectedId} chatId={selectedId} onBack={() => select(selectedId)} /> : mapOpen ? <BranchMap chats={chats} selectedId={selectedId} onOpen={select} /> : profileOpen ? <ProfilePage config={config} navigate={path => navigate(path, selectedId)} /> : gptsOpen ? <GptsPage onStart={current => { updateChat(current); select(current.id) }} /> : environmentsOpen ? config ? <EnvironmentsPage key={route.environmentId ?? "list"} environmentId={route.environmentId} navigate={path => navigate(path, selectedId)} targets={config.execution.targets} onChange={() => { void api<AppConfig>("/api/config").then(setConfig).catch(error => setError(error.message)) }} /> : <div className="settings-scroll"><p role={error ? "alert" : "status"}>{error || "Loading environments…"}</p></div> : settingsOpen ? <SettingsPage section={route.section} onSectionChange={(section: SettingsSection) => navigate(`/settings/${section}`, selectedId)} onClose={() => openSettings(false)} onSave={settings => {
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
                    <h1>What are we working on?</h1>
                </section> : <div className="conversation">
                    {loading && <div className="loading"><span className="spinner" />Loading conversation</div>}
                    {chat?.gpt && !chat.messages.length && <section className="gpt-chat-intro"><Icon name="spark" size={28} /><h1>{chat.gpt.name}</h1><p>{chat.gpt.description || "Send a message to start working with this agent."}</p></section>}
                    {chat?.messages.map(message => isCompactionMessage(message) ? <CompactionMarker key={message.id} message={message} /> : message.role === "activity" ? <details className="activity" key={message.id}>
                        <summary>{message.running ? <span className="spinner" /> : <Icon name="terminal" size={15} />}<span>{message.text}</span><CopyMessageButton text={[message.text, message.detail].filter(Boolean).join("\n\n")} /><Icon name="chevron" size={12} /></summary>
                        <pre>{message.detail ?? (message.running ? "Working…" : "Completed")}</pre>
                    </details> : <article id={`message-${message.id}`} key={message.id} className={`message ${message.role}`}>
                        {message.role === "assistant" && <div className="assistant-label"><PuppyMark size={22} /><span>{chat?.gpt?.name ?? "PuppyGPT"}</span></div>}
                        {message.image && <figure className="generated-image">
                            <a href={`/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`} target="_blank" rel="noreferrer" aria-label="Open generated image at full size">
                                <img src={`/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`} alt={message.image.prompt} loading="lazy" onLoad={() => { if (following) document.getElementById("conversation-end")?.scrollIntoView({ block: "end" }) }} />
                            </a>
                            <figcaption><a href={`/api/chats/${chat.id}/images/${encodeURIComponent(message.id)}`} download="puppygpt-image.png">Download image</a></figcaption>
                        </figure>}
                        {message.role === "error" ? <div role="alert"><strong>Couldn’t finish this turn</strong><p>{message.text}</p><span>You can send another message to continue.</span></div> : message.role === "user" ? <div className="user-bubble">{message.text}</div> : <div className="markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div>}
                        {message.role === "error" && <div className="message-actions"><CopyMessageButton text={message.text} /></div>}
                        {(message.role === "user" || message.role === "assistant") && <MessageBranches key={`${chat.id}:${message.id}`} chat={chat} message={message} chats={chats} config={config} onCreated={updateChat} onOpen={select} />}
                        {message.id === chat.forkMessageId && <ForkMarker onSource={() => select(chat.parentChatId!)} onMap={() => navigate("/map", selectedId)} />}
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
                        <label className="model-picker"><span className="sr-only">Model</span><select aria-label="Model" value={chat?.model ?? model} disabled={!config || loading || sending || running || changingTarget} onChange={event => void changeModel(event.target.value)}><option value="gpt-5.6-sol">GPT-5.6 Sol</option><option value="gpt-5.6-terra">GPT-5.6 Terra</option><option value="gpt-5.6-luna">GPT-5.6 Luna</option><option value="gpt-6-astra">GPT-6 Astra</option></select></label>
                        <span className="toolbar-divider" />
                        <label className="model-picker execution-picker"><span className="execution-label">Environment</span><select aria-label="Environment" value={chat ? chat.executionTarget : executionTarget} disabled={!!selectedId || !config || loading || sending || running || changingTarget} onChange={event => setExecutionTarget(event.target.value)}>
                            {!chat && <option value="">New {config?.execution.defaultTarget ?? "docker"} environment</option>}
                            {config?.execution.targets.map(target => <option key={target.id} value={target.id}>{chat ? config?.execution.environments.find(environment => environment.id === chat.environmentId)?.name ?? target.id : `New ${target.id} environment`}</option>)}
                        </select></label><button type="button" className="workspace-button" onClick={() => chat?.environmentId ? navigate(`/environments/${chat.environmentId}`, selectedId) : openEnvironments()}>{chat ? "Open environment" : "Manage"}</button>
                        {chat && <button type="button" className="workspace-button" disabled={running || sending || changingTarget || !chat.messages.length} onClick={compact} title="Condense the agent context while keeping the conversation history">Compact context</button>}
                    </div><div className="send-actions">{running && <button type="button" className="stop-button" aria-label="Stop agent" onClick={stop}><Icon name="stop" size={16} /></button>}<button type="submit" className="send-button" disabled={!draft.trim() || sending || changingTarget || loading || !config} aria-label={running ? "Send guidance" : "Send message"}>{sending ? <span className="spinner" /> : <Icon name="arrow" size={19} />}</button></div></div>
                    {workspaceOpen && <div className="workspace-editor"><label htmlFor="workspace">Working directory</label><input id="workspace" value={path} readOnly={!!selectedId} onChange={event => setCwd(event.target.value)} /><span>{selectedId ? "Start a new chat to choose another workspace." : "The workspace is mounted into a new environment for this chat."}</span></div>}
                </form>
                <p className="composer-footnote">{running ? "Follow-up messages guide the active turn." : config?.settings.enterToSend === false ? "Ctrl/⌘ + Enter to send · Enter for a new line" : "Enter to send · Shift + Enter for a new line"}</p>
            </div>
            </>}
        </main>

        <KeyboardShortcuts newChat={() => { if (!sending && !changingTarget) select(null) }} />
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
