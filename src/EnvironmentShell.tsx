import { useEffect, useRef, useState } from "react"

export function EnvironmentShell({ id, ready }: { id: string, ready: boolean }) {
    const [command, setCommand] = useState("")
    const [output, setOutput] = useState("")
    const [running, setRunning] = useState(false)
    const controller = useRef<AbortController | null>(null)
    const terminal = useRef<HTMLPreElement>(null)
    useEffect(() => () => controller.current?.abort(), [])
    useEffect(() => { terminal.current?.scrollTo(0, terminal.current.scrollHeight) }, [output])
    const append = (text: string) => setOutput(previous => (previous + text).slice(-256_000))
    const run = async () => {
        if (running || !command.trim()) return
        const abort = new AbortController()
        controller.current = abort
        setRunning(true)
        append(`\n$ ${command}\n`)
        try {
            const response = await fetch(`/api/environments/${id}/shell`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command }), signal: abort.signal })
            if (!response.ok) throw new Error((await response.json()).error ?? "Shell request failed")
            const reader = response.body!.getReader()
            const decoder = new TextDecoder()
            let pending = ""
            while (true) {
                const { value, done } = await reader.read()
                pending += decoder.decode(value, { stream: !done })
                const lines = pending.split("\n")
                pending = lines.pop()!
                for (const line of lines) {
                    if (!line) continue
                    const event = JSON.parse(line)
                    if (event.type === "output") append(event.text)
                    if (event.type === "error") append(`\nError: ${event.message}\n`)
                    if (event.type === "done") append(`\n[${event.timedOut ? "Timed out" : `Exit ${event.exitCode}`}${event.truncated ? "; output truncated" : ""}]\n`)
                }
                if (done) break
            }
        } catch (error) { append(`\n${abort.signal.aborted ? "Command cancelled" : error instanceof Error ? error.message : "Shell failed"}\n`) }
        finally { controller.current = null; setRunning(false) }
    }
    return <section className="settings-card environment-shell" aria-labelledby="shell-title">
        <div className="environment-toolbar"><h2 id="shell-title">Shell</h2><button type="button" onClick={() => setOutput("")}>Clear output</button></div>
        <p className="settings-help">Commands run in this environment’s workspace. Each run starts a fresh shell; use one script for commands that share a directory or variables. Interactive terminal programs are not supported yet.</p>
        <pre ref={terminal} className="environment-terminal" aria-label="Shell output" tabIndex={0}>{output || "Run a command to see its output here."}</pre>
        <form onSubmit={event => { event.preventDefault(); void run() }}>
            <label htmlFor="shell-command">Command</label>
            <textarea id="shell-command" value={command} onChange={event => setCommand(event.target.value)} placeholder="pwd && ls -la" disabled={running} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); if (ready) void run() } }} />
            <div className="environment-toolbar"><p className="settings-help" role="status">{running ? "Running…" : ready ? "Ctrl+Enter to run" : "Start the environment to use its shell."}</p>{running ? <button type="button" onClick={() => controller.current?.abort()}>Stop command</button> : <button type="submit" disabled={!ready || !command.trim()}>Run command</button>}</div>
        </form>
    </section>
}
