import { useEffect, useState } from "react"
import type { UpdateStatus } from "../update/status"
import { Icon } from "./Icon"

export function UpdateIndicator() {
    const [status, setStatus] = useState<UpdateStatus | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        let checking = false
        const check = async () => {
            if (checking || document.visibilityState === "hidden") return
            checking = true
            try {
                const response = await fetch("/api/updates", { signal: controller.signal })
                if (response.ok) setStatus(await response.json())
            } catch { /* Keep the rest of the app usable while offline. */ }
            finally { checking = false }
        }
        void check()
        const timer = setInterval(() => void check(), 60_000)
        document.addEventListener("visibilitychange", check)
        return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", check) }
    }, [])
    if (!status?.available || !status.releaseUrl) return null
    const label = `Update available: ${status.version}. View release notes`
    const detail = status.verification === "verified" ? "Release signature verified." : "Automatic installation requires release signing setup."
    return <a className="icon-button update-indicator" href={status.releaseUrl} target="_blank" rel="noopener noreferrer" aria-label={label} title={`${label} (current ${status.currentVersion}). ${detail}`}>
        <Icon name="download" size={20} />
        <span className="update-indicator-dot" aria-hidden="true" />
    </a>
}
