import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"

export function EnvironmentShell({ id, ready }: { id: string, ready: boolean }) {
    const mount = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const [connection, setConnection] = useState(0)
    const [enabled, setEnabled] = useState(true)
    const [status, setStatus] = useState("Connecting…")
    useEffect(() => {
        if (!ready || !enabled || !mount.current) return
        let disposed = false
        let connected = false
        setStatus("Connecting…")
        const terminal = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: '"SFMono-Regular", Consolas, monospace', scrollback: 5000, theme: { background: "#20231f", foreground: "#e5ecdf", cursor: "#a9ca91" }, allowProposedApi: false })
        terminalRef.current = terminal
        const fit = new FitAddon()
        terminal.loadAddon(fit)
        terminal.open(mount.current)
        const url = new URL(`/api/environments/${id}/terminal`, location.href)
        url.protocol = location.protocol === "https:" ? "wss:" : "ws:"
        const socket = new WebSocket(url)
        socket.binaryType = "arraybuffer"
        const resize = () => {
            if (disposed) return
            fit.fit()
            if (connected && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: Math.min(400, Math.max(2, terminal.cols)), rows: Math.min(200, Math.max(2, terminal.rows)) }))
        }
        const observer = new ResizeObserver(resize)
        observer.observe(mount.current)
        const input = terminal.onData(data => { if (connected && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })) })
        socket.onmessage = event => {
            if (disposed) return
            if (event.data instanceof ArrayBuffer) { terminal.write(new Uint8Array(event.data)); return }
            const message = JSON.parse(event.data)
            if (message.type === "ready") { connected = true; setStatus("Connected"); resize(); terminal.focus() }
            if (message.type === "error") { setStatus(message.message); terminal.writeln(`\r\n${message.message}`) }
            if (message.type === "exit") { setStatus(`Shell exited (${message.code})`); terminal.writeln(`\r\n[Shell exited: ${message.code}]`) }
        }
        socket.onerror = () => { if (!disposed) setStatus("Terminal connection failed. Reconnect to try again.") }
        socket.onclose = () => { connected = false; if (!disposed) setStatus(current => current === "Connected" || current === "Connecting…" ? "Disconnected — reconnect to open a new shell." : current) }
        resize()
        return () => { disposed = true; observer.disconnect(); input.dispose(); socket.close(); terminal.dispose(); terminalRef.current = null }
    }, [id, ready, enabled, connection])
    return <section className="settings-card environment-shell" aria-labelledby="shell-title">
        <div className="environment-toolbar"><h2 id="shell-title">Terminal</h2><div className="account-actions"><button type="button" disabled={!ready} onClick={() => terminalRef.current?.clear()}>Clear</button><button type="button" disabled={!ready || !enabled} onClick={() => { setEnabled(false); setStatus("Disconnected") }}>Disconnect</button><button type="button" disabled={!ready} onClick={() => { setEnabled(true); setConnection(value => value + 1) }}>Reconnect</button></div></div>
        <p className="settings-help" role="status">{ready ? status : "Start the environment to open its terminal."}</p>
        <div ref={mount} className="environment-xterm" aria-label="Interactive environment terminal" />
        <p className="settings-help">Ctrl+C interrupts · Disconnect before stopping the environment · Closing this page ends the shell session.</p>
    </section>
}
