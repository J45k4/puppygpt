import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { AccountUsage, UsageWindow } from "./account-usage"

const count = (n: number | null | undefined) => n == null ? "Not available" : n.toLocaleString()
const date = (s: string | null | undefined) => s && Number.isFinite(Date.parse(s)) ? new Date(s).toLocaleString() : "Not available"
function Window({ name, value }: { name: string, value: UsageWindow }) {
    const duration = value.seconds == null ? "" : value.seconds >= 86400 ? `${value.seconds / 86400} day` : `${value.seconds / 3600} hour`
    return <div className="usage-window"><div><strong>{duration || name} window</strong><span>{value.usedPercent == null ? "Usage unavailable" : `${value.usedPercent}% used · ${Math.max(0, 100 - value.usedPercent)}% left`}</span></div>
        {value.usedPercent != null && <progress aria-label={`${duration || name} usage`} max={100} value={Math.min(100, value.usedPercent)} />}
        <p className="settings-help">Resets {value.resetsAt == null ? "at an unavailable time" : new Date(value.resetsAt * 1000).toLocaleString()}</p>
    </div>
}
export function AccountUsageModal({ account, onClose }: { account: { id: string, label: string }, onClose: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null)
    const [snapshot, setSnapshot] = useState<AccountUsage | null>(null)
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState("")
    const controller = useRef<AbortController | null>(null)
    async function load(refresh: boolean, signal: AbortSignal) {
        setBusy(true); setError("")
        try {
            const response = await fetch(`/api/accounts/${account.id}/usage${refresh ? "/refresh" : ""}`, { signal, ...(refresh ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : {}) })
            if (!response.ok) throw new Error("Could not load account usage. Try again.")
            const result = await response.json() as AccountUsage | null
            if (signal.aborted) return
            setSnapshot(result)
            if (!refresh) await load(true, signal)
        } catch (e) { if (!signal.aborted) setError(e instanceof Error ? e.message : "Could not load usage") }
        finally { if (!signal.aborted) setBusy(false) }
    }
    useEffect(() => {
        dialog.current?.showModal()
        const c = new AbortController(); controller.current = c
        void load(false, c.signal)
        return () => c.abort()
    }, [account.id])
    const limits = snapshot?.limits.data, profile = snapshot?.profile.data, resets = snapshot?.resets.data
    return createPortal(<dialog ref={dialog} className="settings-card account-modal usage-modal" aria-labelledby="usage-title" onCancel={onClose} onClose={onClose}>
        <div className="accounts-heading"><h2 id="usage-title">Usage · {account.label}</h2><button type="button" className="account-modal-close" aria-label="Close usage" onClick={onClose}>×</button></div>
        <div className="usage-toolbar"><p className="settings-help">Account-wide Codex usage{limits?.plan ? ` · ${limits.plan}` : ""}</p><button className="settings-secondary" type="button" disabled={busy} onClick={() => void load(true, controller.current!.signal)}>{busy ? "Refreshing…" : "Refresh"}</button></div>
        {error && <p role="alert" className="settings-error">{error}</p>}
        {busy && !snapshot && <p role="status">Loading usage…</p>}
        {snapshot && <>
            <section className="usage-section"><h3>Usage limits</h3><p className="settings-help">Updated {date(snapshot.limits.fetchedAt)}</p>
                {snapshot.limits.error && <p className="settings-error" role="status">{snapshot.limits.error}{limits && " Showing saved data."}</p>}
                {limits?.windows.map((group, i) => <div key={i}><h4>{group.name}</h4>{group.primary && <Window name="Primary" value={group.primary} />}{group.secondary && <Window name="Secondary" value={group.secondary} />}{!group.primary && !group.secondary && <p className="settings-help">Window data not available.</p>}</div>)}
                <dl className="usage-stats"><div><dt>Credit balance</dt><dd>{limits?.credits?.unlimited ? "Unlimited" : limits?.credits?.balance ?? "Not available"}</dd></div><div><dt>Available resets</dt><dd>{count(resets?.available ?? limits?.availableResets)}</dd></div></dl>
            </section>
            <section className="usage-section"><h3>All-time activity</h3><p className="settings-help">Updated {date(snapshot.profile.fetchedAt)}</p>
                {snapshot.profile.error && <p className="settings-error" role="status">{snapshot.profile.error}{profile && " Showing saved data."}</p>}
                <dl className="usage-stats">{[["Lifetime tokens", profile?.lifetimeTokens], ["Peak daily tokens", profile?.peakDailyTokens], ["Current streak (days)", profile?.currentStreakDays], ["Longest streak (days)", profile?.longestStreakDays], ["Longest turn (seconds)", profile?.longestTurnSeconds]].map(([label, n]) => <div key={label}><dt>{label}</dt><dd>{count(n as number | undefined)}</dd></div>)}</dl>
                {!!profile?.daily.length && <details><summary>Daily token usage</summary><div className="usage-daily"><table className="accounts-table"><thead><tr><th>Date</th><th>Tokens</th></tr></thead><tbody>{profile.daily.map((d,i) => <tr key={i}><td>{d.date}</td><td>{count(d.tokens)}</td></tr>)}</tbody></table></div></details>}
            </section>
            <section className="usage-section"><h3>Reset credits</h3><p className="settings-help">Updated {date(snapshot.resets.fetchedAt)}</p>
                {snapshot.resets.error && <p className="settings-error" role="status">{snapshot.resets.error}{resets && " Showing saved data."}</p>}
                {resets && (resets.credits.length ? <ul className="usage-resets">{resets.credits.map((r,i) => <li key={i}><strong>{r.title ?? "Usage reset"}</strong><span>{r.status ?? "Status unavailable"} · {r.expiresAt ? `Expires ${date(r.expiresAt)}` : "No expiry reported"}</span></li>)}</ul> : <p className="settings-help">No reset credits reported.</p>)}
            </section>
        </>}
    </dialog>, document.body)
}
