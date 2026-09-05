import { useEffect, useRef, useState } from "react"
import type { Environment } from "./environments"
import { EnvironmentShell } from "./EnvironmentShell"

export function EnvironmentsPage({ targets, onChange, environmentId, navigate }: { targets: { id: string, kind: string }[], onChange: () => void, environmentId: string | null, navigate: (path: string) => void }) {
    const heading = useRef<HTMLHeadingElement>(null)
    const [list, setList] = useState<Environment[]>([])
    const [name, setName] = useState("")
    const [target, setTarget] = useState(targets.find(t => t.kind === "docker")?.id ?? targets[0]?.id ?? "")
    const [busy, setBusy] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState("")
    const [deleting, setDeleting] = useState(false)
    const [showStopped, setShowStopped] = useState(true)
    const creating = environmentId === "new"
    const selected = list.find(environment => environment.id === environmentId)
    const refresh = async () => {
        const response = await fetch("/api/environments")
        if (!response.ok) throw new Error("Could not load environments")
        setList(await response.json())
    }
    useEffect(() => {
        heading.current?.focus()
        const update = () => void refresh().catch(error => setError(error.message)).finally(() => setLoading(false))
        update()
        const timer = setInterval(update, 5000)
        return () => clearInterval(timer)
    }, [])
    const action = async (path: string, body: object = {}) => {
        setBusy(true); setError("")
        try {
            const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error ?? "Environment request failed")
            setDeleting(false)
            await refresh(); onChange()
            if (creating) navigate(`/environments/${data.id}`)
            else if (path.endsWith("/delete")) navigate("/environments")
        } catch (error) { setError(error instanceof Error ? error.message : "Request failed") }
        finally { setBusy(false) }
    }
    const visible = list.filter(environment => showStopped || environment.status !== "stopped").sort((a, b) => Number(b.status === "ready") - Number(a.status === "ready"))
    return <div className="settings-scroll"><div className="settings-page environments-page">
        {environmentId && <button className="environment-back" onClick={() => navigate("/environments")}>← All environments</button>}
        <div className="settings-heading environment-toolbar"><div><h1 ref={heading} tabIndex={-1}>{creating ? "New environment" : environmentId ? selected?.name ?? "Environment" : "Environments"}</h1><p>{environmentId ? "Manage your workspace and run commands." : "Your agent workspaces, status, and tools."}</p></div>{!environmentId && <button onClick={() => navigate("/environments/new")}>New environment</button>}</div>
        {error && <p role="alert" className="settings-error">{error}</p>}
        {creating ? <form className="settings-card" onSubmit={event => { event.preventDefault(); void action("/api/environments", { name, targetId: target }) }}>
            <label htmlFor="environment-name">Name</label><input id="environment-name" required value={name} maxLength={80} onChange={event => setName(event.target.value)} />
            <label htmlFor="environment-template">Runtime template</label><select id="environment-template" value={target} onChange={event => setTarget(event.target.value)}>{targets.map(t => <option key={t.id} value={t.id}>{t.id} · {t.kind}</option>)}</select>
            <p className="settings-help">Docker environments persist between runs. Start the environment after creating it. Environments using the same template currently share its workspace files.</p>
            <button className="settings-secondary" disabled={busy || !name.trim() || !target}>{busy ? "Creating…" : "Create environment"}</button>
        </form> : environmentId ? selected ? <>
            <section className="settings-card"><div className="environment-toolbar"><h2>Overview</h2><span className={`environment-status ${selected.status}`}>{selected.status}</span></div>
                <dl className="environment-facts"><div><dt>Runtime</dt><dd>{selected.kind} · {selected.targetId}</dd></div><div><dt>Created</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>Last used</dt><dd>{selected.lastUsedAt ? new Date(selected.lastUsedAt).toLocaleString() : "Not yet used"}</dd></div><div><dt>ID</dt><dd>{selected.id}</dd></div></dl>
                <p className="settings-help">Environments are shared between chats. Starting or stopping one affects every chat using it.</p>
                {selected.kind === "docker" && <div className="environment-toolbar environment-controls">{deleting ? <><span>Delete this container and its files? Mounted workspace files remain.</span><button disabled={busy} onClick={() => void action(`/api/environments/${selected.id}/delete`)}>Confirm delete</button><button disabled={busy} onClick={() => setDeleting(false)}>Keep environment</button></> : <><button disabled={busy || selected.status === "missing" || selected.status === "unavailable"} onClick={() => void action(`/api/environments/${selected.id}/${selected.status === "ready" ? "stop" : "start"}`)}>{busy ? "Updating…" : selected.status === "ready" ? "Stop environment" : "Start environment"}</button><button disabled={busy} onClick={() => setDeleting(true)}>Delete environment</button></>}</div>}
            </section>
            <EnvironmentShell id={selected.id} ready={selected.status === "ready" && !busy} />
        </> : <p role="status">{loading ? "Loading environment…" : "Environment not found."}</p> : <section className="settings-card">
            <div className="environment-toolbar"><h2>Existing environments</h2><label className="settings-check"><input type="checkbox" checked={showStopped} onChange={event => setShowStopped(event.target.checked)} /> Show stopped</label><span>{visible.length} environments</span></div>
            <div className="environment-table-scroll"><table className="environment-table"><thead><tr><th>Environment</th><th>Status</th><th>Runtime</th><th>Created</th><th>Last used</th></tr></thead><tbody>{visible.map(environment => <tr key={environment.id}><td><a href={`/environments/${environment.id}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(`/environments/${environment.id}`) } }}>{environment.name}</a></td><td><span className={`environment-status ${environment.status}`}>{environment.status}</span></td><td>{environment.kind} · {environment.targetId}</td><td>{new Date(environment.createdAt).toLocaleString()}</td><td>{environment.lastUsedAt ? new Date(environment.lastUsedAt).toLocaleString() : "Not yet used"}</td></tr>)}</tbody></table></div>
            {!visible.length && <p role="status">{loading ? "Loading environments…" : "No environments to show."}</p>}
        </section>}
    </div></div>
}
