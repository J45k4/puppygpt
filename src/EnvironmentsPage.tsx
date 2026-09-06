import { EnvironmentWebhooks } from "./EnvironmentWebhooks"
import { useEffect, useState } from "react"
import type { Environment } from "./environments"
import { EnvironmentShell } from "./EnvironmentShell"

export function EnvironmentsPage({ targets, onChange, environmentId, navigate }: { targets: { id: string, kind: string }[], onChange: () => void, environmentId: string | null, navigate: (path: string) => void }) {
    const [now, setNow] = useState(Date.now)
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
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
        {!environmentId && <div className="settings-heading environment-toolbar"><button onClick={() => navigate("/environments/new")}>New environment</button></div>}
        {error && <p role="alert" className="settings-error">{error}</p>}
        {creating ? <form className="settings-card" onSubmit={event => { event.preventDefault(); void action("/api/environments", { name, targetId: target }) }}>
            <label htmlFor="environment-name">Name</label><input id="environment-name" required value={name} maxLength={80} onChange={event => setName(event.target.value)} />
            <label htmlFor="environment-template">Runtime template</label><select id="environment-template" value={target} onChange={event => setTarget(event.target.value)}>{targets.map(t => <option key={t.id} value={t.id}>{t.id} · {t.kind}</option>)}</select>
            <p className="settings-help">Docker environments stop after 4 hours idle. Auto-stopped containers expire after 24 hours; manually stopped containers after 7 days. Start the environment after creating it. Environments using the same template currently share its workspace files.</p>
            <button className="settings-secondary" disabled={busy || !name.trim() || !target}>{busy ? "Creating…" : "Create environment"}</button>
        </form> : environmentId ? selected ? <>
            <section className="settings-card"><div className="environment-toolbar"><h2>Overview</h2><span className={`environment-status ${selected.status}`}>{selected.status}</span></div>
                <dl className="environment-facts"><div><dt>Runtime</dt><dd>{selected.kind} · {selected.targetId}</dd></div><div><dt>Created</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd></div><div><dt>Last used</dt><dd>{selected.lastUsedAt ? new Date(selected.lastUsedAt).toLocaleString() : "Not yet used"}</dd></div><div><dt>ID</dt><dd>{selected.id}</dd></div></dl>
                <p className="settings-help">Environments are shared between chats. Starting or stopping one affects every chat using it.</p>
                {selected.kind === "docker" && <div className="environment-cleanup"><div className="environment-autostop"><span>Auto-stop</span><AutoStopSwitch environment={selected} disabled={busy} onChange={enabled => void action(`/api/environments/${selected.id}/auto-stop`, { enabled })} /></div></div>}
                {selected.kind === "docker" && <div className="environment-toolbar environment-controls">{deleting ? <><span>Delete this container and its files? Mounted workspace files remain.</span><button disabled={busy} onClick={() => void action(`/api/environments/${selected.id}/delete`)}>Confirm delete</button><button disabled={busy} onClick={() => setDeleting(false)}>Keep environment</button></> : <><button disabled={busy || selected.status === "missing" || selected.status === "unavailable"} onClick={() => void action(`/api/environments/${selected.id}/${selected.status === "ready" ? "stop" : "start"}`)}>{busy ? "Updating…" : selected.status === "ready" ? "Stop environment" : "Start environment"}</button><button disabled={busy} onClick={() => setDeleting(true)}>Delete environment</button></>}</div>}
            </section>
            <EnvironmentWebhooks key={selected.id} environmentId={selected.id} />
            <EnvironmentShell id={selected.id} ready={selected.status === "ready" && !busy} />
        </> : <p role="status">{loading ? "Loading environment…" : "Environment not found."}</p> : <section className="settings-card">
            <div className="environment-toolbar"><h2>Existing environments</h2><label className="settings-check"><input type="checkbox" checked={showStopped} onChange={event => setShowStopped(event.target.checked)} /> Show stopped</label><span>{visible.length} environments</span></div>
            <div className="environment-table-scroll"><table className="environment-table"><thead><tr><th>Environment</th><th>Status</th><th>Runtime</th><th>Created</th><th>Last used</th><th>Auto-stop</th><th>Next cleanup</th></tr></thead><tbody>{visible.map(environment => <tr key={environment.id}><td><a href={`/environments/${environment.id}`} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(`/environments/${environment.id}`) } }}>{environment.name}</a></td><td><span className={`environment-status ${environment.status}`}>{environment.status}</span></td><td>{environment.kind} · {environment.targetId}</td><td>{new Date(environment.createdAt).toLocaleString()}</td><td>{environment.lastUsedAt ? new Date(environment.lastUsedAt).toLocaleString() : "Not yet used"}</td><td>{environment.kind === "docker" ? <AutoStopSwitch environment={environment} disabled={busy} onChange={enabled => void action(`/api/environments/${environment.id}/auto-stop`, { enabled })} /> : "—"}</td><td><CleanupTimer environment={environment} now={now} /></td></tr>)}</tbody></table></div>
            {!visible.length && <p role="status">{loading ? "Loading environments…" : "No environments to show."}</p>}
        </section>}
    </div></div>
}

function CleanupTimer({ environment: e, now }: { environment: Environment, now: number }) {
    const kind = e.status === "ready" ? "stop" : "destroy"
    if (e.kind !== "docker") return <span>—</span>
    if (e.cleanupEnabled === false) return <span>Disabled</span>
    if (e.status === "ready" && e.autoStopEnabled === false) return <span>Auto-stop disabled</span>
    if (e.destroyedAt && !e.handle) return <span>Destroyed</span>
    if (!e.handle || e.status === "missing" || e.status === "unavailable") return <span>—</span>
    if (e.cleanupPaused) return <span title="Active turns, commands, and open terminals prevent cleanup">Paused while active</span>
    const deadline = kind === "stop" ? e.autoStopAt : e.destroyAt
    if (!deadline) return <span>—</span>
    const remaining = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000))
    const days = Math.floor(remaining / 86400), hours = Math.floor(remaining / 3600) % 24, minutes = Math.floor(remaining / 60) % 60, seconds = remaining % 60
    const label = !remaining ? "Due at next cleanup" : `${days ? `${days}d ` : ""}${days || hours ? `${hours}h ` : ""}${minutes}m ${seconds}s`
    return <time dateTime={deadline} className="cleanup-countdown" title={`${new Date(deadline).toLocaleString()} · Cleanup checks every 30 minutes`}>{kind === "stop" ? "Auto-stop" : "Destroy"}: {label}</time>
}

function AutoStopSwitch({ environment, disabled, onChange }: { environment: Environment, disabled: boolean, onChange: (enabled: boolean) => void }) {
    const enabled = environment.autoStopEnabled !== false
    return <label className="auto-stop-control"><input type="checkbox" role="switch" aria-label={`Auto-stop ${environment.name}`} checked={enabled} disabled={disabled || environment.cleanupEnabled === false} onChange={event => onChange(event.target.checked)} /><span>{environment.cleanupEnabled === false ? "Kept" : enabled ? "On" : "Off"}</span></label>
}
