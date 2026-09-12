import type { Database } from "bun:sqlite"
import type { AgentFunctionTool } from "./agent/agent"
import type { IntegrationStore } from "./integrations"
import type { RoutingStore, SubscriptionEvent } from "./routing"

export class DiscordSendStore {
    constructor(private db: Database, private integrations: IntegrationStore, private routing: RoutingStore) {
        db.run("CREATE TABLE IF NOT EXISTS discord_reply_channels (chat_id TEXT NOT NULL, integration_id TEXT NOT NULL, channel_id TEXT NOT NULL, event TEXT NOT NULL, PRIMARY KEY(chat_id, integration_id, channel_id))")
    }
    grant(chatId: string, event: SubscriptionEvent) {
        if (event.event.provider !== "discord" || !event.conversation?.id) return
        this.db.query("INSERT INTO discord_reply_channels VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, integration_id, channel_id) DO UPDATE SET event=excluded.event").run(chatId, event.event.integrationId, event.conversation.id, JSON.stringify(event))
    }
    agentTool(chatId: string): AgentFunctionTool {
        return {
            definition: {
                type: "function", name: "discord_send_message", strict: false,
                description: "Send a Discord message using a saved bot integration. For replies, copy integration_id from event.integrationId, channel_id from conversation.id, and optional reply_to_message_id from message.id in the incoming Discord event. Only channels routed to this chat by a currently enabled rule are permitted. Normal assistant text appears only in the local chat. Check the returned status; never claim delivery on failure or unknown status.",
                parameters: { type: "object", additionalProperties: false, properties: {
                    integration_id: { type: "string" }, channel_id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 2000 }, reply_to_message_id: { type: "string" },
                }, required: ["integration_id", "channel_id", "text"] },
            },
            label: args => `Discord send · ${String(args.integration_id ?? "")} · channel ${String(args.channel_id ?? "")}`,
            execute: async args => {
                // Return failures as results so the normal tool activity records every outcome.
                const request = { integration_id: args.integration_id, channel_id: args.channel_id, text: args.text, ...(args.reply_to_message_id !== undefined ? { reply_to_message_id: args.reply_to_message_id } : {}) }
                try {
                    if (Object.keys(args).some(key => !["integration_id", "channel_id", "text", "reply_to_message_id"].includes(key))) throw new Error("Unsupported message argument")
                    if (typeof args.integration_id !== "string" || typeof args.channel_id !== "string" || !/^\d{1,20}$/.test(args.channel_id)) throw new Error("Choose a valid integration and Discord channel ID")
                    if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 2000) throw new Error("Message text must be 1–2000 characters")
                    if (args.reply_to_message_id !== undefined && (typeof args.reply_to_message_id !== "string" || !/^\d{1,20}$/.test(args.reply_to_message_id))) throw new Error("Invalid reply message ID")
                    const row = this.db.query<{ event: string }, [string, string, string]>("SELECT event FROM discord_reply_channels WHERE chat_id=? AND integration_id=? AND channel_id=?").get(chatId, args.integration_id, args.channel_id)
                    if (!row) throw new Error("This integration and channel have not routed a message to this chat")
                    const result = this.routing.test(JSON.parse(row.event))
                    if (result.actions.some(action => action.type === "ignore") || !result.actions.some(action => action.type === "deliver" && (action.destination.kind === "new_chat" || action.destination.chatId === chatId))) throw new Error("The routing rule no longer permits replies from this chat")
                    return { ...request, ...await this.integrations.sendDiscord(args.integration_id, args.channel_id, args.text, args.reply_to_message_id as string | undefined) }
                } catch (error) { return { ...request, status: "failed", error: error instanceof Error ? error.message : "Discord send failed" } }
            },
        }
    }
}
