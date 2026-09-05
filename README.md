# puppygpt

Local Bun + React chat workspace backed by the PuppyGPT agent.

The standalone [agent loop](src/agent/README.md) lives in `src/agent`.

Create a chat, select a model and working directory, and send a task. Replies and
command activity stream into the conversation. Send another message while the agent
is working to guide the active turn, or use Stop to cancel it.

Chats and completed-turn agent context are saved in `.puppygpt/chats.sqlite` and
restored after a restart. An interrupted turn is marked in the chat; send a new
message to continue from the last saved agent context. The agent uses the local
Codex subscription credentials by default. You can also connect named OpenAI
accounts in Settings → Accounts: choose Add account, then Connect OpenAI, enter the displayed device code on
OpenAI's sign-in page, then save the selected account for new chats. This uses
ChatGPT subscription credentials, including for image generation, and refreshes
them automatically. There is no local OAuth callback server. Existing chats keep
their original connection. Removing a connection deletes its encrypted credentials;
its old chats cannot run until you start a new chat with an available connection.
Added-account tokens are stored in the `accounts.auth` SQLite BLOB, encrypted with
AES-256-GCM, a fresh nonce per write, and account-bound authenticated data. The
32-byte key is stored separately in the data directory's `auth.key` (mode 0600).
Back up this key together with the database; losing it requires restoring the key
or reconnecting accounts. Database-only copies cannot decrypt credentials, but
processes that can read both the key and database can. The API never returns tokens.
Existing account auth files are migrated at startup and removed only after the
encrypted blob is committed and verified. The local Codex login continues to use
Codex's own auth file. Each chat has its own
conversation, while chats targeting the same directory share those files.

The Usage button beside each account opens account-wide Codex statistics. The
local Codex login appears in the same table with its own Usage button. Opening the modal loads the saved
snapshot and refreshes it; Refresh updates it again. Limits, reset times, credit
balance, available reset credits, lifetime tokens, streaks, and daily token usage
are shown when OpenAI returns them. Missing values remain unavailable.

Usage snapshots are stored in the SQLite `account_usage` table, separately from
tokens. Each section keeps its last successful data and timestamp if a refresh
fails. Removing a connection also deletes its usage snapshot. These are latest
snapshots, not a locally accumulated usage ledger. The adapter follows Codex's
backend-client reads of `/wham/usage`, `/wham/profiles/me`, and
`/wham/rate-limit-reset-credits`; upstream endpoint availability can vary. Reading
usage never redeems reset credits.

The server binds to `127.0.0.1:3000`. Override `PORT`, `PUPPYGPT_WORKDIR`, or
`PUPPYGPT_DATA_DIR` as needed. This is a local application with host-level tool
execution, not a multi-user hosted service.

```bash
bun install
bun dev        # Development server with hot reload
bun run build  # Static production assets in dist/
bun start      # Production server
bun test       # Agent and chat API regression tests
bun run check  # TypeScript checks
```
