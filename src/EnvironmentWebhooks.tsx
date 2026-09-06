import { useEffect, useState } from "react"
import type { Webhook } from "./webhooks"

export function EnvironmentWebhooks({ environmentId }: { environmentId: string }) {
    const [hooks, setHooks] = useState<Webhook[]>([])
    const [name, setName] = useState("")
    const [port, setPort] = useState("3000")
    const [path, setPath] = useState("/webhook")
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    const refresh = async () => {
        const response = await fetch("/api/webhooks")
        if (!response.ok) throw new Error("Could not load webhooks")
        setHooks((await response.json() as Webhook[]).filter(hook => hook.environmentId === environmentId))
    }
    useEffect(() => { void refresh().catch(error => setError(error.message)) }, [environmentId])
    const save = async (url: string, body: object) => {
        setBusy(true); setError("")
        try {
            const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
            const data = await response.json()
            if (!response.ok) throw new Error(data.error ?? "Could not save webhook")
            await refresh()
            if (url === "/api/webhooks") setName("")
        } catch (error) { setError(error instanceof Error ? error.message : "Request failed") }
        finally { setBusy(false) }
    }
    return <section className="settings-card">
        <h2>Webhooks</h2>
        {error && <p role="alert" className="settings-error">{error}</p>}
        {!!hooks.length && <div className="environment-table-scroll"><table className="environment-table"><thead><tr><th>Name</th><th>Destination</th><th>Webhook URL</th><th>Enabled</th><th /></tr></thead><tbody>{hooks.map(hook => <tr key={hook.id}>
            <td>{hook.name}</td><td><code>{hook.port}{hook.path}</code></td>
            <td><input aria-label={`Webhook URL for ${hook.name}`} readOnly value={`${location.origin}/webhooks/${hook.id}`} onFocus={event => event.target.select()} /></td>
            <td><input type="checkbox" role="switch" aria-label={`Enable ${hook.name}`} checked={hook.enabled} disabled={busy} onChange={event => void save(`/api/webhooks/${hook.id}`, { enabled: event.target.checked })} /></td>
            <td><button disabled={busy} onClick={() => void save(`/api/webhooks/${hook.id}/delete`, {})}>Delete</button></td>
        </tr>)}</tbody></table></div>}
        <form className="webhook-form" onSubmit={event => { event.preventDefault(); void save("/api/webhooks", { name, port: Number(port), path, environmentId }) }}>
            <label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
            <label>Port<input required type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
            <label>Path<input required placeholder="/webhook" value={path} onChange={event => setPath(event.target.value)} /></label>
            <button disabled={busy}>Add webhook</button>
        </form>
        <p className="settings-help">Keep webhook URLs private. Requests go to this environment’s localhost while it is running. External senders need an HTTPS proxy or tunnel to PuppyGPT.</p>
    </section>
}
