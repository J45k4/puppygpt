import { Database } from "bun:sqlite"
import type { AgentFunctionTool } from "./agent/agent"
import type { JsonObject } from "./agent/types"

export const ROUTING_FIELDS = [
    "event.id", "event.type", "event.provider", "event.integrationId",
    "sender.id", "sender.name", "sender.username", "sender.email",
    "conversation.id", "conversation.name", "conversation.type",
    "message.id", "message.text", "message.subject",
] as const

export type RoutingField = typeof ROUTING_FIELDS[number]
type Scalar = string | number | boolean | null
export type RoutingFilter =
    | { op: "all", rules: RoutingFilter[] }
    | { op: "any", rules: RoutingFilter[] }
    | { op: "not", rule: RoutingFilter }
    | { op: "exists", field: RoutingField }
    | { op: "eq", field: RoutingField, value: Scalar }
    | { op: "neq", field: RoutingField, value: Scalar }
    | { op: "contains", field: RoutingField, value: Scalar }
    | { op: "starts_with", field: RoutingField, value: Scalar }
    | { op: "ends_with", field: RoutingField, value: Scalar }
    | { op: "matches", field: RoutingField, value: Scalar }
    | { op: "in", field: RoutingField, values: Scalar[] }

export type SubscriptionEvent = {
    event: { id: string, type: string, provider: string, integrationId: string }
    sender?: { id?: string, name?: string, username?: string, email?: string }
    conversation?: { id?: string, name?: string, type?: string }
    message?: { id?: string, text?: string, subject?: string }
}

export type RoutingAction =
    | { type: "deliver", destination: { kind: "chat", chatId: string } | { kind: "new_chat", environmentId?: string } }
    | { type: "add_instruction", text: string }
    | { type: "label", value: string }
    | { type: "reply", text: string }
    | { type: "ignore" }

export type RoutingRule = {
    id: string
    revision: number
    name: string
    enabled: boolean
    source: { integrationId: string }
    when: RoutingFilter
    actions: RoutingAction[]
    continue: boolean
    owner: { type: "user" | "agent" | "system", id: string }
    protection: "editable" | "approval_required" | "locked"
    createdAt: string
    updatedAt: string
}

export type RoutingTable = { version: 1, revision: number, rules: RoutingRule[], fallback: RoutingAction[] }
export type RoutingPermission = {
    principalId: string
    level: "observe" | "propose" | "manage"
    integrationIds: string[]
    ownRulesOnly: boolean
    updatedAt: string
}
export type RoutingProposal = { id: string, principalId: string, operation: string, input: JsonObject, status: "pending" | "approved" | "rejected", createdAt: string }
export type RouteTrace = { ruleId: string, ruleName: string, sourceMatched: boolean, filterMatched: boolean, selected: boolean }

const fields = new Set<string>(ROUTING_FIELDS)
const MAX_FILTER_DEPTH = 8
const MAX_FILTER_NODES = 100
const MAX_TEXT = 4_000

const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
    return value as Record<string, unknown>
}
const text = (value: unknown, label: string, maximum = MAX_TEXT): string => {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${label} must be 1-${maximum} characters`)
    return value.trim()
}
const scalar = (value: unknown, label: string): Scalar => {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error(`${label} must be a string, number, boolean, or null`)
    if (typeof value === "string" && value.length > MAX_TEXT) throw new Error(`${label} is too long`)
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must be finite`)
    return value as Scalar
}

export const validateFilter = (value: unknown): RoutingFilter => {
    let nodes = 0
    const visit = (input: unknown, depth: number): RoutingFilter => {
        if (depth > MAX_FILTER_DEPTH) throw new Error(`Filter depth exceeds ${MAX_FILTER_DEPTH}`)
        if (++nodes > MAX_FILTER_NODES) throw new Error(`Filter has more than ${MAX_FILTER_NODES} nodes`)
        const item = object(input, "Filter")
        const op = text(item.op, "Filter operation", 24)
        if (op === "all" || op === "any") {
            if (!Array.isArray(item.rules) || !item.rules.length) throw new Error(`${op} requires at least one rule`)
            return { op, rules: item.rules.map(rule => visit(rule, depth + 1)) }
        }
        if (op === "not") return { op, rule: visit(item.rule, depth + 1) }
        const field = text(item.field, "Filter field", 80)
        if (!fields.has(field)) throw new Error(`Unsupported filter field: ${field}`)
        if (op === "exists") return { op, field: field as RoutingField }
        if (op === "in") {
            if (!Array.isArray(item.values) || !item.values.length || item.values.length > 100) throw new Error("in requires 1-100 values")
            return { op, field: field as RoutingField, values: item.values.map((entry, index) => scalar(entry, `Value ${index + 1}`)) }
        }
        if (!["eq", "neq", "contains", "starts_with", "ends_with", "matches"].includes(op)) throw new Error(`Unsupported filter operation: ${op}`)
        const result = { op, field: field as RoutingField, value: scalar(item.value, "Filter value") } as RoutingFilter
        if (op === "matches") {
            if (typeof item.value !== "string" || item.value.length > 256) throw new Error("matches requires a pattern of at most 256 characters")
            try { new RegExp(item.value, "iu") } catch { throw new Error("Invalid regular expression") }
        }
        return result
    }
    return visit(value, 1)
}

const fieldValue = (event: SubscriptionEvent, field: RoutingField): unknown => {
    const [group, key] = field.split(".") as [keyof SubscriptionEvent, string]
    return (event[group] as Record<string, unknown> | undefined)?.[key]
}
export const matchesFilter = (filter: RoutingFilter, event: SubscriptionEvent): boolean => {
    if (filter.op === "all") return filter.rules.every(rule => matchesFilter(rule, event))
    if (filter.op === "any") return filter.rules.some(rule => matchesFilter(rule, event))
    if (filter.op === "not") return !matchesFilter(filter.rule, event)
    const actual = fieldValue(event, filter.field)
    if (filter.op === "exists") return actual !== undefined && actual !== null && actual !== ""
    if (filter.op === "in") return filter.values.some(value => Object.is(actual, value))
    if (filter.op === "eq") return Object.is(actual, filter.value)
    if (filter.op === "neq") return !Object.is(actual, filter.value)
    if (typeof actual !== "string" || typeof filter.value !== "string") return false
    if (filter.op === "contains") return actual.includes(filter.value)
    if (filter.op === "starts_with") return actual.startsWith(filter.value)
    if (filter.op === "ends_with") return actual.endsWith(filter.value)
    return new RegExp(filter.value, "iu").test(actual)
}

export const normalizeSubscriptionEvent = (value: unknown): SubscriptionEvent => {
    const input = object(value, "Event")
    const event = object(input.event, "event")
    const result: SubscriptionEvent = { event: {
        id: text(event.id, "event.id", 256), type: text(event.type, "event.type", 128),
        provider: text(event.provider, "event.provider", 64), integrationId: text(event.integrationId, "event.integrationId", 128),
    } }
    for (const group of ["sender", "conversation", "message"] as const) {
        if (input[group] === undefined) continue
        const source = object(input[group], group)
        const allowed = group === "sender" ? ["id", "name", "username", "email"] : group === "conversation" ? ["id", "name", "type"] : ["id", "text", "subject"]
        const target: Record<string, string> = {}
        for (const key of allowed) if (source[key] !== undefined) target[key] = text(source[key], `${group}.${key}`)
        ;(result as unknown as Record<string, unknown>)[group] = target
    }
    return result
}

const validateAction = (value: unknown): RoutingAction => {
    const action = object(value, "Action")
    const type = text(action.type, "Action type", 32)
    if (type === "ignore") return { type }
    if (type === "add_instruction") return { type, text: text(action.text, "Instruction") }
    if (type === "reply") return { type, text: text(action.text, "Reply") }
    if (type === "label") return { type, value: text(action.value, "Label", 128) }
    if (type === "deliver") {
        const destination = object(action.destination, "Destination")
        if (destination.kind === "chat") return { type, destination: { kind: "chat", chatId: text(destination.chatId, "Chat ID", 128) } }
        if (destination.kind === "new_chat") return { type, destination: { kind: "new_chat", ...(destination.environmentId === undefined ? {} : { environmentId: text(destination.environmentId, "Environment ID", 128) }) } }
        throw new Error("Destination kind must be chat or new_chat")
    }
    throw new Error(`Unsupported routing action: ${type}`)
}

const validateRuleInput = (value: unknown, current?: RoutingRule, owner?: RoutingRule["owner"]): RoutingRule => {
    const input = object(value, "Rule")
    const now = new Date().toISOString()
    const actions = input.actions
    if (!Array.isArray(actions) || !actions.length || actions.length > 20) throw new Error("A rule needs 1-20 actions")
    const source = object(input.source, "Rule source")
    const protection = input.protection ?? current?.protection ?? "editable"
    if (!["editable", "approval_required", "locked"].includes(String(protection))) throw new Error("Invalid rule protection")
    return {
        id: current?.id ?? crypto.randomUUID(), revision: (current?.revision ?? 0) + 1,
        name: text(input.name, "Rule name", 120), enabled: input.enabled === undefined ? current?.enabled ?? true : Boolean(input.enabled),
        source: { integrationId: text(source.integrationId, "Integration ID", 128) },
        when: validateFilter(input.when), actions: actions.map(validateAction), continue: Boolean(input.continue),
        owner: current?.owner ?? owner ?? { type: "user", id: "local" },
        protection: protection as RoutingRule["protection"], createdAt: current?.createdAt ?? now, updatedAt: now,
    }
}

export const evaluateRouting = (table: RoutingTable, input: unknown) => {
    const event = normalizeSubscriptionEvent(input)
    const actions: RoutingAction[] = []
    const trace: RouteTrace[] = []
    for (const rule of table.rules) {
        if (!rule.enabled) { trace.push({ ruleId: rule.id, ruleName: rule.name, sourceMatched: false, filterMatched: false, selected: false }); continue }
        const sourceMatched = rule.source.integrationId === "*" || rule.source.integrationId === event.event.integrationId
        const filterMatched = sourceMatched && matchesFilter(rule.when, event)
        trace.push({ ruleId: rule.id, ruleName: rule.name, sourceMatched, filterMatched, selected: filterMatched })
        if (!filterMatched) continue
        actions.push(...rule.actions)
        if (!rule.continue) break
    }
    if (!actions.length) actions.push(...table.fallback)
    return { actions, trace }
}

type DataRow = { data: string }
export class RoutingStore {
    constructor(private db: Database) {
        db.run("CREATE TABLE IF NOT EXISTS routing_state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS routing_permissions (principal_id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS routing_proposals (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        db.run("CREATE TABLE IF NOT EXISTS routing_audit (position INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)")
        db.query("INSERT OR IGNORE INTO routing_state (id, data) VALUES (1, ?)").run(JSON.stringify({ version: 1, revision: 0, rules: [], fallback: [] }))
    }

    table(): RoutingTable { return JSON.parse(this.db.query<DataRow, []>("SELECT data FROM routing_state WHERE id = 1").get()!.data) }
    private save(table: RoutingTable, actor: string, operation: string, detail: unknown) {
        this.db.transaction(() => {
            this.db.query("UPDATE routing_state SET data = ? WHERE id = 1").run(JSON.stringify(table))
            this.db.query("INSERT INTO routing_audit (data) VALUES (?)").run(JSON.stringify({ at: new Date().toISOString(), actor, operation, revision: table.revision, detail }))
        })()
    }
    permission(principalId: string): RoutingPermission {
        const row = this.db.query<DataRow, [string]>("SELECT data FROM routing_permissions WHERE principal_id = ?").get(principalId)
        return row ? JSON.parse(row.data) : { principalId, level: "observe", integrationIds: ["*"], ownRulesOnly: true, updatedAt: new Date().toISOString() }
    }
    permissions(): RoutingPermission[] { return this.db.query<DataRow, []>("SELECT data FROM routing_permissions ORDER BY principal_id").all().map(row => JSON.parse(row.data)) }
    setPermission(principalId: string, input: unknown): RoutingPermission {
        text(principalId, "Principal ID", 128)
        const item = object(input, "Permission")
        if (!["observe", "propose", "manage"].includes(String(item.level))) throw new Error("Access level must be observe, propose, or manage")
        if (!Array.isArray(item.integrationIds) || !item.integrationIds.length || item.integrationIds.length > 100) throw new Error("Choose at least one integration scope")
        const permission: RoutingPermission = { principalId, level: item.level as RoutingPermission["level"], integrationIds: item.integrationIds.map((id, i) => text(id, `Integration scope ${i + 1}`, 128)), ownRulesOnly: item.ownRulesOnly !== false, updatedAt: new Date().toISOString() }
        this.db.transaction(() => {
            this.db.query("INSERT INTO routing_permissions (principal_id, data) VALUES (?, ?) ON CONFLICT(principal_id) DO UPDATE SET data=excluded.data").run(principalId, JSON.stringify(permission))
            this.db.query("INSERT INTO routing_audit (data) VALUES (?)").run(JSON.stringify({ at: permission.updatedAt, actor: "user:local", operation: "permission.update", detail: permission }))
        })()
        return permission
    }
    proposals(): RoutingProposal[] { return this.db.query<DataRow, []>("SELECT data FROM routing_proposals ORDER BY rowid DESC").all().map(row => JSON.parse(row.data)) }
    resolveProposal(id: string, approve: boolean): RoutingProposal {
        const row = this.db.query<DataRow, [string]>("SELECT data FROM routing_proposals WHERE id = ?").get(id)
        if (!row) throw new Error("Routing proposal not found")
        const proposal = JSON.parse(row.data) as RoutingProposal
        if (proposal.status !== "pending") throw new Error("Routing proposal was already resolved")
        if (approve) {
            const revision = Number(proposal.input.expected_revision)
            if (proposal.operation === "disable") this.disableRule(text(proposal.input.rule_id, "Rule ID", 128), revision, "user:local")
            else this.putRule(proposal.input.rule, revision, proposal.operation === "update" ? text(proposal.input.rule_id, "Rule ID", 128) : undefined, "user:local", { type: "agent", id: proposal.principalId })
        }
        proposal.status = approve ? "approved" : "rejected"
        this.db.transaction(() => {
            this.db.query("UPDATE routing_proposals SET data = ? WHERE id = ?").run(JSON.stringify(proposal), id)
            this.db.query("INSERT INTO routing_audit (data) VALUES (?)").run(JSON.stringify({ at: new Date().toISOString(), actor: "user:local", operation: `proposal.${proposal.status}`, detail: { proposalId: id } }))
        })()
        return proposal
    }
    audit(limit = 50): unknown[] { return this.db.query<DataRow, [number]>("SELECT data FROM routing_audit ORDER BY position DESC LIMIT ?").all(Math.max(1, Math.min(limit, 200))).map(row => JSON.parse(row.data)) }
    test(event: unknown) { return evaluateRouting(this.table(), event) }

    putRule(input: unknown, expectedRevision: number, id?: string, actor = "user:local", owner?: RoutingRule["owner"]): RoutingRule {
        const table = this.table()
        if (expectedRevision !== table.revision) throw new Error(`Routing table changed: expected revision ${expectedRevision}, current revision ${table.revision}`)
        const index = id ? table.rules.findIndex(rule => rule.id === id) : -1
        if (id && index < 0) throw new Error("Routing rule not found")
        const rule = validateRuleInput(input, index >= 0 ? table.rules[index] : undefined, owner)
        if (index >= 0) table.rules[index] = rule
        else table.rules.push(rule)
        table.revision += 1
        this.save(table, actor, index >= 0 ? "rule.update" : "rule.create", { ruleId: rule.id })
        return rule
    }
    disableRule(id: string, expectedRevision: number, actor = "user:local"): RoutingRule {
        const table = this.table()
        if (expectedRevision !== table.revision) throw new Error(`Routing table changed: expected revision ${expectedRevision}, current revision ${table.revision}`)
        const rule = table.rules.find(rule => rule.id === id)
        if (!rule) throw new Error("Routing rule not found")
        rule.enabled = false; rule.revision += 1; rule.updatedAt = new Date().toISOString(); table.revision += 1
        this.save(table, actor, "rule.disable", { ruleId: id })
        return rule
    }
    setFallback(input: unknown, expectedRevision: number): RoutingTable {
        const table = this.table()
        if (expectedRevision !== table.revision) throw new Error(`Routing table changed: expected revision ${expectedRevision}, current revision ${table.revision}`)
        if (!Array.isArray(input) || input.length > 20) throw new Error("Fallback must contain at most 20 actions")
        table.fallback = input.map(validateAction); table.revision += 1
        this.save(table, "user:local", "fallback.update", {})
        return table
    }

    private propose(principalId: string, operation: string, input: JsonObject): RoutingProposal {
        const proposal: RoutingProposal = { id: crypto.randomUUID(), principalId, operation, input, status: "pending", createdAt: new Date().toISOString() }
        this.db.transaction(() => {
            this.db.query("INSERT INTO routing_proposals (id, data) VALUES (?, ?)").run(proposal.id, JSON.stringify(proposal))
            this.db.query("INSERT INTO routing_audit (data) VALUES (?)").run(JSON.stringify({ at: proposal.createdAt, actor: `agent:${principalId}`, operation: "proposal.create", detail: { proposalId: proposal.id, requestedOperation: operation } }))
        })()
        return proposal
    }
    private assertScope(permission: RoutingPermission, integrationId: string) {
        if (!permission.integrationIds.includes("*") && !permission.integrationIds.includes(integrationId)) throw new Error("This agent is not allowed to manage that integration")
    }
    agentTool(principalId: string, listIntegrations: () => unknown[] = () => []): AgentFunctionTool {
        return {
            definition: ROUTING_TOOL,
            label: input => `Routing · ${String(input.operation ?? "inspect")}`,
            execute: input => {
                const operation = String(input.operation ?? "")
                const permission = this.permission(principalId)
                if (operation === "list") return { table: this.table(), permission, integrations: listIntegrations(), proposals: this.proposals().filter(item => item.principalId === principalId) }
                if (operation === "test") return this.test(input.event)
                if (operation === "explain") return { fields: ROUTING_FIELDS, operations: ["list", "test", "create", "update", "disable"], permission, integrations: listIntegrations() }
                if (!["create", "update", "disable"].includes(operation)) throw new Error("Unknown routing operation")
                if (permission.level === "observe") throw new Error("This agent has observe-only routing access")
                const table = this.table()
                const expectedRevision = Number(input.expected_revision)
                if (!Number.isSafeInteger(expectedRevision)) throw new Error("expected_revision is required")
                let integrationId = "*"
                let existing: RoutingRule | undefined
                if (operation === "disable" || operation === "update") {
                    const id = text(input.rule_id, "Rule ID", 128)
                    existing = table.rules.find(rule => rule.id === id)
                    if (!existing) throw new Error("Routing rule not found")
                    integrationId = existing.source.integrationId
                    if (existing.protection === "locked") throw new Error("This routing rule is locked")
                    if (permission.ownRulesOnly && (existing.owner.type !== "agent" || existing.owner.id !== principalId)) throw new Error("This agent can only change rules it owns")
                } else {
                    integrationId = text(object(input.rule, "Rule").source && object(object(input.rule, "Rule").source, "Rule source").integrationId, "Integration ID", 128)
                }
                this.assertScope(permission, integrationId)
                if (operation === "update") {
                    const replacement = object(input.rule, "Rule")
                    this.assertScope(permission, text(object(replacement.source, "Rule source").integrationId, "Integration ID", 128))
                }
                const shouldPropose = permission.level === "propose" || existing?.protection === "approval_required"
                if (shouldPropose) return { applied: false, proposal: this.propose(principalId, operation, input) }
                const actor = `agent:${principalId}`
                const rule = operation === "disable"
                    ? this.disableRule(text(input.rule_id, "Rule ID", 128), expectedRevision, actor)
                    : this.putRule(input.rule, expectedRevision, operation === "update" ? text(input.rule_id, "Rule ID", 128) : undefined, actor, { type: "agent", id: principalId })
                return { applied: true, rule, tableRevision: this.table().revision }
            },
        }
    }
}

export const ROUTING_TOOL: JsonObject = {
    type: "function", name: "routing", strict: false,
    description: "Inspect, test, or edit the host-managed subscription routing table. Changes require externally granted propose or manage access and an expected table revision. Filters use a small JSON AST.",
    parameters: { type: "object", properties: {
        operation: { type: "string", enum: ["list", "test", "explain", "create", "update", "disable"] },
        expected_revision: { type: "integer" }, rule_id: { type: "string" },
        rule: { type: "object", description: "Rule with name, enabled, source.integrationId, when filter AST, actions, and continue." },
        event: { type: "object", description: "Normalized subscription event to evaluate without delivering it." },
    }, required: ["operation"] },
}
