import { useEffect, useRef, useState } from "react"
import { AccountUsageModal } from "./AccountUsageModal"
import { createPortal } from "react-dom"
import type { AccountLogin, ConnectedAccount, LocalAccount } from "./account-types"

async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? "Account request failed")
    return data
}

export function AccountsPanel({ selectedId, onSelect }: { selectedId: string | null, onSelect: (id: string | null) => void }) {
    const [usageAccount, setUsageAccount] = useState<{ id: string, label: string } | null>(null)
    const dialog = useRef<HTMLDialogElement>(null)
    const [adding, setAdding] = useState(false)
    useEffect(() => {
        if (adding) dialog.current?.showModal()
        else dialog.current?.close()
    }, [adding])
    const [localAccount, setLocalAccount] = useState<LocalAccount | null>(null)
    const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
    const [attempt, setAttempt] = useState<AccountLogin | null>(null)
    const [label, setLabel] = useState("")
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")
    const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
    const pending = attempt?.status === "starting" || attempt?.status === "pending"
    const refresh = async () => { setAccounts(await api<ConnectedAccount[]>("/api/accounts")) }
    useEffect(() => {
        void refresh().catch(error => setError(error.message))
        void api<LocalAccount>("/api/accounts/local").then(setLocalAccount).catch(error => setError(error.message))
        const id = sessionStorage.getItem("puppygpt-account-login")
        if (id) void api<AccountLogin>(`/api/accounts/login/${id}`).then(setAttempt).catch(() => sessionStorage.removeItem("puppygpt-account-login"))
    }, [])
    useEffect(() => {
        if (!pending || !attempt) return
        let disposed = false
        let timer: ReturnType<typeof setTimeout>
        const poll = async () => {
            try {
                const result = await api<AccountLogin>(`/api/accounts/login/${attempt.id}`)
                if (disposed) return
                setAttempt(result)
                if (result.status === "connected") {
                    sessionStorage.removeItem("puppygpt-account-login")
                    await refresh()
                    if (result.account) onSelect(result.account.id)
                }
                if (result.status === "starting" || result.status === "pending") timer = setTimeout(poll, 1200)
                else sessionStorage.removeItem("puppygpt-account-login")
            } catch (error) {
                if (!disposed) { setError(error instanceof Error ? error.message : "Could not check sign-in"); timer = setTimeout(poll, 3000) }
            }
        }
        timer = setTimeout(poll, 300)
        return () => { disposed = true; clearTimeout(timer) }
    }, [attempt?.id, pending])
    const connect = async () => {
        setBusy(true); setError("")
        try {
            const result = await api<AccountLogin>("/api/accounts/openai/connect", { label: label.trim() || "OpenAI account" })
            sessionStorage.setItem("puppygpt-account-login", result.id)
            setAttempt(result)
        } catch (error) { setError(error instanceof Error ? error.message : "Could not connect") }
        finally { setBusy(false) }
    }
    const cancel = async () => {
        if (!attempt) return
        setBusy(true); setError("")
        try { setAttempt(await api<AccountLogin>(`/api/accounts/login/${attempt.id}/cancel`, {})); sessionStorage.removeItem("puppygpt-account-login") }
        catch (error) { setError(error instanceof Error ? error.message : "Could not cancel") }
        finally { setBusy(false) }
    }
    const remove = async (id: string) => {
        setBusy(true); setError("")
        try {
            await api(`/api/accounts/${id}/remove`, {})
            if (selectedId === id) onSelect(null)
            setConfirmRemove(null); await refresh()
        } catch (error) { setError(error instanceof Error ? error.message : "Could not remove account") }
        finally { setBusy(false) }
    }
    return <section className="settings-card accounts-panel" aria-labelledby="accounts-title">
        <div className="accounts-heading"><h2 id="accounts-title">Connected accounts</h2><button type="button" className="settings-secondary" onClick={() => { if (!pending) { setAttempt(null); setLabel(""); setError("") }; setAdding(true) }}>{pending ? "Continue sign-in" : "Add account"}</button></div><p className="settings-help">Sign in to your ChatGPT account using a device code. PuppyGPT uses this connection for chat and image generation.</p>
        {error && !adding && <p className="settings-error" role="alert">{error}</p>}
        <div className="accounts-table-wrap"><table className="accounts-table">
            <caption className="sr-only">Connected accounts</caption>
            <thead><tr><th scope="col">Account</th><th scope="col">Provider</th><th scope="col">Default</th><th scope="col">Actions</th></tr></thead>
            <tbody><tr>
                <td><strong>{localAccount?.name ?? "Local Codex login"}</strong>{localAccount?.email && <span className="account-email">{localAccount.email}</span>}<span className="account-email">{localAccount?.available === false ? "Local Codex login unavailable" : "Managed by Codex"}</span></td>
                <td>OpenAI<span className="account-email">ChatGPT{localAccount?.plan ? ` · ${localAccount.plan}` : ""}</span></td>
                <td><input type="radio" name="default-account" aria-label="Use local Codex login for new chats" checked={selectedId === null} disabled={busy} onChange={() => onSelect(null)} /></td>
                <td><div className="account-actions"><button type="button" onClick={() => setUsageAccount({ id: "local", label: "Local Codex login" })}>Usage</button></div></td>
            </tr>{accounts.map(account => <tr key={account.id}>
                <td><strong>{account.label}</strong>{account.email && <span className="account-email">{account.email}</span>}</td>
                <td>OpenAI<span className="account-email">ChatGPT</span></td>
                <td><input type="radio" name="default-account" aria-label={`Use ${account.label} for new chats`} checked={selectedId === account.id} disabled={busy} onChange={() => onSelect(account.id)} /></td>
                <td><div className="account-actions"><button type="button" onClick={() => setUsageAccount(account)}>Usage</button>{confirmRemove === account.id ? <div className="account-remove"><p>Remove these local credentials? Chats using this account will no longer run.</p><button type="button" disabled={busy} onClick={() => void remove(account.id)}>Remove connection</button><button type="button" disabled={busy} onClick={() => setConfirmRemove(null)}>Keep</button></div> : <button type="button" aria-label={`Remove ${account.label}`} disabled={busy || pending} onClick={() => setConfirmRemove(account.id)}>Remove</button>}</div></td>
            </tr>)}</tbody>
        </table></div>
        {usageAccount && <AccountUsageModal key={usageAccount.id} account={usageAccount} onClose={() => setUsageAccount(null)} />}
        <p className="settings-help">Save settings to apply your default. Existing chats keep their account.</p>
        {attempt?.status === "connected" && !adding && <p role="status">OpenAI connected. Save settings to use it for new chats.</p>}
        {createPortal(<dialog ref={dialog} className="settings-card account-modal" aria-labelledby="add-account-title" onCancel={() => setAdding(false)} onClose={() => setAdding(false)}>
            <div className="accounts-heading"><h2 id="add-account-title">Add account</h2><button type="button" className="account-modal-close" aria-label="Close add account" onClick={() => setAdding(false)}>×</button></div>
            <p className="settings-help">Connect your OpenAI account using a device code.</p>
            {error && <p className="settings-error" role="alert">{error}</p>}
        {pending ? <div className="account-signin" role="status"><strong>{attempt?.userCode ? "Enter this code on OpenAI" : "Complete sign-in with OpenAI"}</strong>
            {attempt?.userCode && <code>{attempt.userCode}</code>}
            {attempt?.verificationUrl ? <a href={attempt.verificationUrl} target="_blank" rel="noreferrer">Continue to OpenAI ↗</a> : <p>Preparing sign-in…</p>}
            <p className="settings-help">Sign in using the account you want to connect. This request expires in five minutes.</p><button type="button" disabled={busy} onClick={() => void cancel()}>Cancel sign-in</button>
        </div> : <div className="account-connect">
            {attempt?.status === "connected" && <p role="status">OpenAI connected. Save settings to use it for new chats.</p>}
            {attempt?.status === "error" && <p className="settings-error" role="alert">{attempt.error}</p>}
            <label htmlFor="account-label">Name</label><input id="account-label" autoFocus onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (!busy) void connect() } }} maxLength={80} placeholder="Personal, work…" value={label} disabled={busy} onChange={event => setLabel(event.target.value)} />
            <button type="button" className="settings-secondary" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect OpenAI"}</button>
        </div>}
            {pending && <p className="settings-help">You can close this window and return with Continue sign-in.</p>}
        </dialog>, document.body)}
        <p className="settings-help">Credentials are stored on this computer. Removing a connection does not sign you out of OpenAI in your browser.</p>
    </section>
}
