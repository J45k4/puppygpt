import { useEffect, useState } from "react"
import type { AppConfig } from "./chat-types"
import type { ConnectedAccount, LocalAccount } from "./account-types"
import { MODELS } from "./settings"

export function ProfilePage({ config, navigate }: { config: AppConfig | null, navigate: (path: string) => void }) {
    const [identity, setIdentity] = useState<{ name: string, email?: string, plan?: string } | null>(null)
    const [error, setError] = useState("")
    const [retry, setRetry] = useState(0)
    useEffect(() => {
        if (!config) return
        const controller = new AbortController()
        setIdentity(null); setError("")
        const selected = config.settings.accountId
        fetch(selected ? "/api/accounts" : "/api/accounts/local", { signal: controller.signal }).then(async response => {
            const data = await response.json()
            if (!response.ok) throw new Error(data.error ?? "Could not load profile")
            if (controller.signal.aborted) return
            if (selected) {
                const account = (data as ConnectedAccount[]).find(account => account.id === selected)
                if (!account) throw new Error("Selected account is unavailable")
                setIdentity({ name: account.label, email: account.email })
            } else {
                const account = data as LocalAccount
                setIdentity({ name: account.name || "Personal workspace", email: account.email, plan: account.plan })
            }
        }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
        return () => controller.abort()
    }, [config?.settings.accountId, !!config, retry])
    return <div className="settings-scroll"><div className="profile-page">
        <h1>Profile</h1>
        {error ? <p className="error-banner" role="alert">{error} <button onClick={() => setRetry(value => value + 1)}>Retry</button></p> : !identity ? <p role="status">Loading profile…</p> : <div className="profile-identity"><div className="local-avatar" aria-hidden="true">{identity.name.charAt(0).toUpperCase()}</div><div><h2>{identity.name}</h2>{identity.email && <p>{identity.email}</p>}{identity.plan && <p>{identity.plan} plan</p>}</div></div>}
        {config && <>
            <section className="profile-section"><div className="profile-section-heading"><h2>Account</h2><button onClick={() => navigate("/settings/accounts")}>Manage accounts</button></div><p>{config.settings.accountId ? "Using your selected connected account for new chats." : "Using the local account for new chats."}</p></section>
            <section className="profile-section"><div className="profile-section-heading"><h2>Preferences</h2><button onClick={() => navigate("/settings/preferences")}>Edit preferences</button></div><dl><div><dt>Workspace</dt><dd>{config.settings.cwd}</dd></div><div><dt>Default model</dt><dd>{MODELS.find(model => model.id === config.settings.model)?.label ?? config.settings.model}</dd></div></dl></section>
        </>}
    </div></div>
}
