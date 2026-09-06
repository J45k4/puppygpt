import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { EnvironmentStore } from "./environments"
import { upgradeTerminal } from "./terminal"
import { ChatStore } from "./chats"
import { mkdtemp, rm } from "node:fs/promises"

test("PTY retains shell state, resizes, interrupts commands, and closes its process", async () => {
    const db = new Database(":memory:")
    const store = new EnvironmentStore(db)
    let output = ""
    const decoder = new TextDecoder()
    const session = await store.openTerminal("default-host", "/tmp", data => { output += decoder.decode(data, { stream: true }) }, () => {})
    const until = async (text: string) => {
        const deadline = Date.now() + 5000
        while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(10)
        expect(output).toContain(text)
    }
    let pid = 0
    try {
        session.write("stty -echo; printf 'SHELL_PID=%s\\n' $$\r")
        await until("SHELL_PID=")
        await until("\r\n")
        const deadline = Date.now() + 3000
        while (!/SHELL_PID=(\d+)/.test(output) && Date.now() < deadline) await Bun.sleep(10)
        pid = Number(/SHELL_PID=(\d+)/.exec(output)?.[1])
        expect(pid).toBeGreaterThan(0)
        session.write("export PUPPY_TERMINAL_PROOF=retained; cd /; printf 'STATE_SET\\n'\r")
        await until("STATE_SET")
        session.resize(100, 35)
        session.write("printf 'STATE=%s:%s\\n' \"$PUPPY_TERMINAL_PROOF\" \"$PWD\"; stty size\r")
        await until("STATE=retained:/")
        await until("35 100")
        session.write("printf 'SLEEP_STARTED\\n'; sleep 30\r")
        await until("SLEEP_STARTED")
        session.write("\x03")
        session.write("printf 'INTERRUPTED_OK\\n'\r")
        await until("INTERRUPTED_OK")
    } finally { await session.close(); db.close() }
    expect(() => process.kill(pid, 0)).toThrow()
}, 15000)

test("terminal upgrade rejects foreign origins, missing origins, and unknown environments", async () => {
    const directory = await mkdtemp("/tmp/puppygpt-terminal-api-")
    const store = new ChatStore(new Database(":memory:"), directory)
    const server = { upgrade: () => { throw new Error("Must not upgrade") } } as unknown as Parameters<typeof upgradeTerminal>[1]
    try {
        for (const origin of [undefined, "https://evil.test"]) {
            const request = new Request("http://localhost/api/environments/default-host/terminal", { headers: origin ? { Origin: origin } : {} })
            expect(upgradeTerminal(request, server, store)?.status).toBe(403)
        }
        expect(upgradeTerminal(new Request("http://localhost/api/environments/missing/terminal", { headers: { Origin: "http://localhost" } }), server, store)?.status).toBe(404)
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }) }
})
