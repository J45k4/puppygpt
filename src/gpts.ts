import type { Database } from "bun:sqlite"
import { MODELS, type Settings } from "./settings"

export type Gpt = { id: string, name: string, description: string, instructions: string, model: string, reasoningEffort: Settings["reasoningEffort"], updatedAt: string }
export type GptInput = Omit<Gpt, "id" | "updatedAt">
export function validateGpt(value: unknown): GptInput {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an agent configuration")
    const v = value as Record<string, unknown>
    if (Object.keys(v).some(key => !["name", "description", "instructions", "model", "reasoningEffort"].includes(key))) throw new Error("Unknown agent setting")
    if (typeof v.name !== "string" || !v.name.trim() || v.name.trim().length > 80) throw new Error("Choose a name of 1–80 characters")
    if (typeof v.description !== "string" || v.description.length > 500) throw new Error("Description must be at most 500 characters")
    const instructions = v.instructions === undefined ? "" : v.instructions
    if (typeof instructions !== "string" || instructions.length > 16000) throw new Error("Instructions must be at most 16,000 characters")
    if (!MODELS.some(model => model.id === v.model)) throw new Error("Unsupported model")
    if (!["low", "medium", "high"].includes(String(v.reasoningEffort))) throw new Error("Invalid reasoning effort")
    return { name: v.name.trim(), description: v.description.trim(), instructions: instructions.trim(), model: v.model as string, reasoningEffort: v.reasoningEffort as GptInput["reasoningEffort"] }
}
export class GptStore {
    constructor(private db: Database) { db.run("CREATE TABLE IF NOT EXISTS gpts (id TEXT PRIMARY KEY, data TEXT NOT NULL)") }
    list(): Gpt[] { return this.db.query<{data:string}, []>("SELECT data FROM gpts ORDER BY json_extract(data, '$.updatedAt') DESC, id").all().map(row => JSON.parse(row.data)) }
    get(id: string): Gpt { const row = this.db.query<{data:string}, [string]>("SELECT data FROM gpts WHERE id=?").get(id); if (!row) throw new Error("GPT not found"); return JSON.parse(row.data) }
    save(value: unknown, id?: string): Gpt {
        if (id) this.get(id)
        const gpt: Gpt = { ...validateGpt(value), id: id ?? crypto.randomUUID(), updatedAt: new Date().toISOString() }
        this.db.query("INSERT INTO gpts VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(gpt.id, JSON.stringify(gpt))
        return gpt
    }
    delete(id: string) { this.get(id); this.db.query("DELETE FROM gpts WHERE id=?").run(id) }
}
