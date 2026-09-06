import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { EnvironmentStore } from "./environments"
import { WebhookStore } from "./webhooks"

test("webhooks preserve payload, signatures, query and response; persist and disable routes", async () => {
    let received: { body: string, signature: string | null, url: string } | undefined
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
        received = { body: await req.text(), signature: req.headers.get("x-signature"), url: req.url }
        return new Response("accepted", { status: 202, headers: { "Set-Cookie": "unsafe=1" } })
    } })
    const db = new Database(":memory:")
    try {
        const environments = new EnvironmentStore(db), hooks = new WebhookStore(db, environments)
        const hook = hooks.save({ name: "Events", environmentId: "default-host", port: upstream.port, path: "/events?configured=1" })
        expect(new WebhookStore(db, environments).list()).toEqual([hook])
        const body = '{ "exact": "☃" }\n'
        const reply = await hooks.handle(new Request(`http://localhost/webhooks/${hook.id}?event=push`, { method: "POST", headers: { "X-Signature": "original" }, body }))
        expect(reply.status).toBe(202)
        expect(await reply.text()).toBe("accepted")
        expect(reply.headers.has("set-cookie")).toBe(false)
        expect(received).toEqual({ body, signature: "original", url: `http://127.0.0.1:${upstream.port}/events?configured=1&event=push` })
        hooks.save({ enabled: false }, hook.id)
        expect((await hooks.handle(new Request(`http://localhost/webhooks/${hook.id}`))).status).toBe(404)
        hooks.delete(hook.id)
        expect(hooks.list()).toEqual([])
    } finally { upstream.stop(true); db.close() }
})

test("webhook destinations reject invalid paths, missing environments, ports and browser requests", async () => {
    const db = new Database(":memory:")
    try {
        const hooks = new WebhookStore(db, new EnvironmentStore(db))
        const input = { name: "Events", environmentId: "default-host", port: 3001, path: "/events" }
        for (const path of ["//evil.test", "/\\evil.test", "https://evil.test", "/x#fragment"]) expect(() => hooks.save({ ...input, path })).toThrow()
        expect(() => hooks.save({ ...input, port: 0 })).toThrow()
        expect(() => hooks.save({ ...input, environmentId: "missing" })).toThrow()
        const hook = hooks.save(input)
        expect((await hooks.handle(new Request(`http://localhost/webhooks/${hook.id}`, { headers: { Origin: "https://evil.test" } }))).status).toBe(403)
        expect((await hooks.handle(new Request(`http://localhost/webhooks/${hook.id}`, { method: "POST", body: "x".repeat(70001) }))).status).toBe(413)
    } finally { db.close() }
})

test("Docker delivery executes the HTTP client inside the owned container and refuses stopped containers", async () => {
    const db = new Database(":memory:")
    let running = true, executions = 0
    const environments = new EnvironmentStore(db, { defaultTarget: "docker", targets: [{ id: "docker", kind: "docker", image: "test", workspaceRoot: "/tmp", network: "none" }] }, async (_socket, args) => {
        if (args[0] === "inspect") return JSON.stringify({ Config: { Labels: { "puppygpt.environment": "default-docker" } }, State: { Running: running } })
        expect(args.slice(0, 4)).toEqual(["exec", "owned-container", "bun", "-e"])
        executions++
        // Run the exact container script locally to verify its serialized code and payload protocol.
        const process = Bun.spawn(["bun", "-e", args[4]!, args[5]!], { stdout: "pipe", stderr: "pipe" })
        const output = await new Response(process.stdout).text()
        expect(await process.exited).toBe(0)
        return output
    })
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("container reply") })
    try {
        const environment = environments.get("default-docker")!
        db.query("UPDATE execution_environments SET data=? WHERE id=?").run(JSON.stringify({ ...environment, handle: { containerId: "owned-container" } }), environment.id)
        const hooks = new WebhookStore(db, environments)
        const hook = hooks.save({ name: "Docker", environmentId: environment.id, port: upstream.port, path: "/" })
        const request = () => new Request(`http://localhost/webhooks/${hook.id}`, { method: "POST", body: "test" })
        expect(await (await hooks.handle(request())).text()).toBe("container reply")
        running = false
        expect((await hooks.handle(request())).status).toBe(502)
        expect(executions).toBe(1)
    } finally { upstream.stop(true); db.close() }
})
