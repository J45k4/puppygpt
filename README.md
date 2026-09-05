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

## Environments

Choose **Environment** in the chat composer. **Manage** and the sidebar
**Environments** link open `/environments`, with Create, Start, Stop, and Delete actions. Multiple chats can select
the same environment. A chat stores `environmentId`; environment records live in
the SQLite `execution_environments` table with a runtime target ID, adapter handle,
status, creation time, and last-used time. Deleting or switching a chat never
removes its environment.

Runtime target definitions currently serve as creation templates. Copy
`execution.example.json` to `.puppygpt/execution.json`, choose an already installed
image and absolute workspace root, then start with:

```sh
PUPPYGPT_EXECUTION_CONFIG=.puppygpt/execution.json bun run dev
```

The runtime creates a default environment record for each configured target.
Docker records start stopped: use **Start** before sending commands. Host is a
built-in environment. Remove host from runtime configuration to prohibit host
execution. Only the chat's selected environment target is exposed to the agent.

Docker environments use long-running containers and `docker exec`. Their writable
container filesystem, user-installed tools, and services survive commands; files
also survive stop/start and app restart. The configured workspace is mounted at
`/workspace`; its `.puppygpt` directory is masked. Other workspace files are visible.
Deleting the environment deletes its container filesystem but preserves mounted
workspace files. There is no automatic deletion or recreation on command completion,
chat changes, app shutdown, or missing-container detection.

Images must provide `/bin/sh`, `sleep infinity`, and util-linux `setsid --wait`.
Containers run as the runtime UID/GID, with capabilities dropped, no privilege
escalation, and configured CPU/memory/PID limits. Network defaults to none. The
runtime does not forward its environment variables or Docker socket into containers.
Docker requires CLI and local Unix socket access; the app never invokes sudo.
No images are pulled automatically. The runtime's target image, mounts, and resource
policy are checked against the saved environment configuration; changed policies
make existing environments unavailable until their original configuration is restored.

Concurrent commands share files and services. Each command has a separate process
group; cancellation/timeout kills that group without stopping the environment or
other commands. Commands that intentionally detach into a different process group
are not covered by that cancellation boundary. Stop/Delete is refused while this
runtime is executing commands in the environment. Environment-backed commands stay
in the foreground when steering arrives. Full output logs are stored on the host.

The runtime reconciles saved container handles with Docker when environments are
listed or used, verifies ownership labels, and reports stopped, missing, or
unavailable environments. It never silently recreates a missing environment.
Creation errors may leave a stopped/missing record for explicit deletion. Keep
runtime configuration outside agent-writable mounts. These controls cover exec;
image tools and the development server still operate on the host. An app running
from agent-writable source is not a complete agent sandbox.

Standalone `createExecutor` remains available for temporary per-command containers;
the web app routes commands through the persistent EnvironmentStore instead.
