import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { RoutingStore, evaluateRouting, validateFilter, type RoutingTable } from "./routing"
import { ChatStore } from "./chats"

const event = {
    event: { id: "event-1", type: "message.created", provider: "telegram", integrationId: "telegram-main" },
    sender: { id: "42", username: "teppo" },
    conversation: { id: "room-1", type: "direct" },
    message: { id: "message-1", text: "deploy staging please" },
}

const rule = (name: string, phrase: string, continue_: boolean) => ({
    id: crypto.randomUUID(), revision: 1, name, enabled: true,
    source: { integrationId: "telegram-main" },
    when: { op: "contains" as const, field: "message.text" as const, value: phrase },
    actions: [{ type: "label" as const, value: name }], continue: continue_,
    owner: { type: "user" as const, id: "local" }, protection: "editable" as const,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
})

test("routing evaluates ordered rules, continue, fallback, and traces", () => {
    const table: RoutingTable = { version: 1, revision: 2, rules: [rule("deploy", "deploy", true), rule("staging", "staging", false)], fallback: [{ type: "ignore" }] }
    expect(evaluateRouting(table, event)).toMatchObject({
        actions: [{ type: "label", value: "deploy" }, { type: "label", value: "staging" }],
        trace: [{ selected: true }, { selected: true }],
    })
    expect(evaluateRouting({ ...table, rules: [] }, event).actions).toEqual([{ type: "ignore" }])
})

test("filter AST is bounded and rejects unknown fields and invalid regular expressions", () => {
    expect(validateFilter({ op: "all", rules: [{ op: "eq", field: "sender.id", value: "42" }, { op: "matches", field: "message.text", value: "deploy|release" }] })).toBeTruthy()
    expect(() => validateFilter({ op: "eq", field: "credentials.token", value: "x" })).toThrow("Unsupported filter field")
    expect(() => validateFilter({ op: "matches", field: "message.text", value: "[" })).toThrow("Invalid regular expression")
})

test("agent changes obey external access, ownership, scope, revisions, and proposals", async () => {
    const store = new RoutingStore(new Database(":memory:"))
    const principal = crypto.randomUUID()
    const tool = store.agentTool(principal)
    expect(() => tool.execute({ operation: "create", expected_revision: 0, rule: { name: "No", source: { integrationId: "telegram-main" }, when: { op: "exists", field: "message.text" }, actions: [{ type: "ignore" }] } })).toThrow("observe-only")
    store.setPermission(principal, { level: "propose", integrationIds: ["telegram-main"], ownRulesOnly: true })
    const proposed = await tool.execute({ operation: "create", expected_revision: 0, rule: { name: "Deploy", source: { integrationId: "telegram-main" }, when: { op: "contains", field: "message.text", value: "deploy" }, actions: [{ type: "deliver", destination: { kind: "new_chat" } }] } }) as { applied: boolean, proposal: { id: string } }
    expect(proposed.applied).toBe(false)
    store.resolveProposal(proposed.proposal.id, true)
    expect(store.table().rules[0]).toMatchObject({ name: "Deploy", owner: { type: "agent", id: principal } })
    store.setPermission(principal, { level: "manage", integrationIds: ["telegram-main"], ownRulesOnly: true })
    const changed = await tool.execute({ operation: "disable", expected_revision: 1, rule_id: store.table().rules[0]!.id }) as { applied: boolean }
    expect(changed.applied).toBe(true)
    expect(() => tool.execute({ operation: "create", expected_revision: 2, rule: { name: "Discord", source: { integrationId: "discord-main" }, when: { op: "exists", field: "message.text" }, actions: [{ type: "ignore" }] } })).toThrow("not allowed")
    expect(store.audit()).not.toHaveLength(0)
})

test("human rule updates use optimistic table revisions", () => {
    const store = new RoutingStore(new Database(":memory:"))
    const input = { name: "Direct messages", source: { integrationId: "*" }, when: { op: "eq", field: "conversation.type", value: "direct" }, actions: [{ type: "ignore" }] }
    store.putRule(input, 0)
    expect(() => store.putRule(input, 0)).toThrow("current revision 1")
})

test("agent rule updates validate both old and replacement integration scopes", async () => {
    const store = new RoutingStore(new Database(":memory:")), principal = crypto.randomUUID()
    const owned = store.putRule(rule("Owned", "deploy", false), 0, undefined, `agent:${principal}`, { type: "agent", id: principal })
    const tool = store.agentTool(principal)
    for (const level of ["manage", "propose"] as const) {
        store.setPermission(principal, { level, integrationIds: ["telegram-main"], ownRulesOnly: true })
        for (const integrationId of ["discord-main", "*"]) {
            expect(() => tool.execute({ operation: "update", rule_id: owned.id, expected_revision: 1, rule: { ...owned, source: { integrationId } } })).toThrow("not allowed")
        }
        expect(store.table().revision).toBe(1)
        expect(store.proposals()).toHaveLength(0)
    }
    store.setPermission(principal, { level: "manage", integrationIds: ["telegram-main", "discord-main"], ownRulesOnly: true })
    expect(await tool.execute({ operation: "update", rule_id: owned.id, expected_revision: 1, rule: { ...owned, source: { integrationId: "discord-main" } } })).toMatchObject({ applied: true })
    store.setPermission(principal, { level: "manage", integrationIds: ["telegram-main"], ownRulesOnly: true })
    expect(() => tool.execute({ operation: "update", rule_id: owned.id, expected_revision: 2, rule: owned })).toThrow("not allowed")
})

test("a normalized subscription event is delivered into the selected agent loop", async () => {
    const root = await mkdtemp("/tmp/puppygpt-routing-delivery-")
    const authFile = `${root}/auth.json`
    const access = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")
    await Bun.write(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: `x.${access}.x`, refresh_token: "refresh" } }))
    const sse = new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Event handled" }] } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "response-1" } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } })
    const store = new ChatStore(new Database(":memory:"), root, { authFile, fetchImpl: async () => sse.clone() })
    try {
        const chat = await store.create(root)
        store.routing.putRule({ name: "Telegram direct", source: { integrationId: "telegram-main" }, when: { op: "eq", field: "conversation.type", value: "direct" }, actions: [{ type: "add_instruction", text: "Treat this as support." }, { type: "deliver", destination: { kind: "chat", chatId: chat.id } }] }, 0)
        const result = await store.routeSubscriptionEvent(event)
        expect(result.delivered).toEqual([chat.id])
        expect(store.get(chat.id)?.messages[0]?.detail).toContain("Routing instructions:\n- Treat this as support.")
        expect(store.get(chat.id)?.messages[0]?.detail).toContain('"sender": {')
        await store.settled()
        expect(store.get(chat.id)?.messages.map(message => [message.role, message.text])).toEqual([["user", "telegram · teppo · channel room-1\ndeploy staging please"], ["assistant", "Event handled"]])
    } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})
