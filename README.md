# puppygpt

Local Bun + React chat workspace backed by the PuppyGPT agent.

The standalone [agent loop](src/agent/README.md) lives in `src/agent`.

Create a chat, select a model and working directory, and send a task. Replies and
command activity stream into the conversation. Send another message while the agent
is working to guide the active turn, or use Stop to cancel it.

Chats and completed-turn agent context are saved in `.puppygpt/chats.sqlite` and
restored after a restart. Chat metadata and agent context live in `chats`; each
message has its own row in `messages`, ordered by `chat_id` and `position`.
Existing embedded message arrays migrate automatically in a transaction on startup.
Streaming text and tool activity are saved as they arrive; agent context is saved
at the end of each turn. An interrupted turn is marked in the chat; send a new
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
docker build -f Dockerfile.execution -t puppygpt-exec:local .
bun dev        # Development server with hot reload
bun run build  # Static production assets in dist/
bun start      # Production server
bun test       # Agent and chat API regression tests
bun run check  # TypeScript checks
```

## Environments

New chats create a dedicated Docker environment by default. The first message
starts its container automatically; subsequent turns and server restarts reuse
that same environment. A stopped chat container starts again on the next message.
Startup errors stay in the chat; execution never silently falls back to the host.
The composer opens the chat's environment detail page, including its shell.
New chats keep their environment assignment for their lifetime. Existing shared
chats retain their assignments and API compatibility.

The built-in Docker template uses `puppygpt-exec:local` (build it above), bridge
networking, 2 GiB memory, 2 CPUs, and 256 PIDs. The server user needs Docker access.
Each chat has a separate container filesystem, but the configured host workspace
is still bind-mounted: chats using the same workspace share those project files.
Automatic cleanup stops Docker environments after 4 hours idle, then removes
auto-stopped containers after 24 hours or manually stopped containers after 7 days.
The cleanup API can disable automatic cleanup per environment. External mounts
are preserved.
Choose a host template explicitly before creating a chat if host execution is needed.

Runtime target definitions currently serve as creation templates. Startup loads
`execution.json` from the data directory when present; `PUPPYGPT_EXECUTION_CONFIG`
overrides that path. Existing templates must retain their configuration for
existing environments; add a new template ID when changing container settings. Copy
`execution.example.json` to `.puppygpt/execution.json`, choose an already installed
image and absolute workspace root, then start with:

```sh
PUPPYGPT_EXECUTION_CONFIG=.puppygpt/execution.json bun run dev
```

The runtime creates a default environment record for each configured target.
Manually created Docker records start stopped: use **Start** to use their shell.
Chat-owned Docker records start automatically on the first message. Host is a
built-in environment. Remove host from runtime configuration to prohibit host
execution. Only the chat's selected environment target is exposed to the agent.

Docker environments use long-running containers and `docker exec`. Their writable
container filesystem, user-installed tools, and services survive commands; files
also survive stop/start and app restart. The configured workspace is mounted at
`/workspace`; its `.puppygpt` directory is masked. Other workspace files are visible.
Deleting the environment deletes its container filesystem but preserves mounted
workspace files. Cleanup retains the environment record and chat history. A chat-owned expired
environment is recreated on the next message. No containers are removed merely
because a command finishes, a chat changes, or the app shuts down. Missing or
unverifiable containers are not automatically deleted or recreated.

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

### Interactive terminal

Environment detail pages use xterm.js with automatic fitting, connected over a
same-origin WebSocket to a Bun PTY. Docker terminals attach to the environment's
existing container. Shell state, working directory, ANSI output, keyboard input,
Ctrl+C, and terminal resizing work interactively. Disconnect before stopping or
deleting the environment. Closing the page terminates that shell session;
Reconnect opens a fresh shell. Newly created containers use Docker init to reap
exited child processes. Existing containers are preserved.

### Rootless Docker

A rootless daemon can run PuppyGPT containers under your user account without
membership in the host `docker` group. Install it following
[Docker's rootless setup](https://docs.docker.com/engine/security/rootless/), then
build the execution image on that daemon:

```sh
docker --host unix:///run/user/$(id -u)/docker.sock build -f Dockerfile.execution -t puppygpt-exec:local .
```

Add a new Docker target to your execution configuration with a unique ID,
`"socketPath": "/run/user/1000/docker.sock"` (use your actual UID), and
`"rootless": true`, and make its ID `defaultTarget`. Keep old target definitions
for existing containers; containers and images belong to their original daemon.
The rootless flag verifies the daemon's security options before creating a
container, then uses container UID/GID `0:0`, which maps to your host user and
allows writes to the workspace. It refuses a rootful daemon. CPU/memory/PID limits
require cgroup v2 and systemd delegation. The mounted workspace remains writable
unless the target specifies `readOnly`.

### Conversation branches

Use **Fork from here** on a completed user or assistant message to start a new
conversation at that point. **Ask about this** opens an inline question form:
optionally select text first, then type your question and send. Replies
appear in an expandable branch and can be opened as a full chat. The sidebar's
**Branch map** (`/map`) shows parent/child connections, supports title highlighting,
conversation filtering and zoom, and opens chats when you select a node.

Forks reference the original message prefix instead of copying its rows. Messages
record `parent_message_id` / `parent_chat_id`; chat metadata records the source
chat, fork message, current head and optional selected passage. New agent turns
save per-message `context_checkpoints`, including tool results and compacted model
context. A fork starts a new agent session from its historical checkpoint and does
not include later source-chat messages. Older messages without checkpoints use
only their visible transcript prefix, which is identified in the branch conversation.
Forking waits until the source chat's current turn finishes.

Forks inherit the model and GPT configuration and offer an environment and workspace
folder choice. Sharing an environment or folder shares file changes; forking does
not clone files, containers, or Git worktrees. A different workspace must already
exist and be accessible to the chosen environment.

Use **Compact context** in the chat composer or an expanded inline branch to
condense the agent context immediately. It runs between turns, keeps the displayed
history, and records a compaction marker. Stop cancels it; failures and cancellation
retain the previous context.

Cleanup checks run every 30 minutes. Active chat turns, compaction, commands, and
open terminals prevent cleanup. Activity refreshes the idle timer when it finishes.
Existing environments receive a fresh grace period when cleanup is first enabled;
reenabling cleanup also resets the grace period. Chat notifications report auto-stop,
warn during the final hour before expiry, and report container removal. A stopped
container's writable layer and anonymous volumes are removed; installed tools and
container-local files do not survive expiry. Project files in the bind-mounted
workspace do survive, including uncommitted changes. There is no global Docker
prune or image removal.

### Integrations

Settings → Integrations stores named Telegram and Discord bot connections. You can
add, edit, remove, and test a connection. Bot tokens are encrypted in the SQLite
`integrations.auth` column with a local `integrations.key` beside `auth.key`; back up
the key together with the database. Tokens are never returned by the settings API.
Test connection checks bot identity without sending any messages.

Connections are independent of agent sessions. The intended messaging model is
explicit outbound tools plus opt-in subscriptions to normalized incoming events.
Saving a connection does not start listeners or send messages. Subscription
adapters can submit normalized events to the local `/api/routing/events` endpoint;
the ordered routing table then filters them and delivers selected events to agent
loops. Telegram and Discord receiver processes are not yet connected.

### Schedules

Open **Schedules** in the sidebar, or use the clock button in a chat, to create a
one-time or recurring agent wakeup. A schedule can continue a specific idle chat
or create a fresh agent chat for every run. If a specific chat is already busy,
PuppyGPT starts a fresh related chat rather than steering the active turn.

Recurring schedules support start-anchored intervals or standard five-field cron
expressions in an IANA timezone. Interval minutes and hours measure elapsed time;
days and months preserve local wall time across daylight saving changes. Monthly
intervals use the last day of shorter months, then return to the original day.
Existing cron schedules keep their calendar-field behavior. Preview respects the
maximum runs, including runs already claimed when editing a schedule.
Start time is required; end time and maximum runs are optional for human-created
schedules. Agent-created recurrence must include one of those limits. Schedules,
next-run timestamps, run history, permissions, proposals, and audit entries are
stored in SQLite. On restart, a run up to two minutes late executes once; older
missed occurrences are recorded and skipped. Agents default to managing only
their own schedules, and their access can be changed to observe, propose, or
manage from the Schedules page.

### Environment webhooks

Open an environment and use **Webhooks** to create a private URL mapped to that environment's localhost port and path. Routes persist in SQLite and can be disabled or deleted. Send requests to `/webhooks/<generated-id>`; treat the generated URL as a secret. Management uses the existing local, same-origin `/api/webhooks` API (`GET` list, `POST` create, `POST /:id` update, `POST /:id/delete` remove).

The receiver preserves the HTTP method, raw body, provider signature headers, and query parameters. It forwards to the configured path, returns the upstream status/body, and does not follow redirects. Cookie and proxy headers are filtered; responses cannot set app cookies or run active content on the app origin. Limits are 70 KB per request, 1 MB per response, and a 10-second upstream timeout. Browser-origin requests are rejected. Delivery is synchronous with no queue or automatic retry; unavailable/stopped environments return HTTP 502 and are not started automatically. Active deliveries prevent environment cleanup and refresh idle activity.

Docker forwarding runs Bun's HTTP client inside the verified environment container, so no container ports need publishing (including rootless Docker and containers with no external network). Custom execution images must provide `bun`. The Host environment forwards to host localhost. PuppyGPT still binds to `127.0.0.1`; external providers need an HTTPS proxy/tunnel exposing only `/webhooks/*`, not the management API. Verify provider signatures in your destination handler.

## Subscription voice

With the composer empty, click the **Start voice** waveform in the send-button
position. A new chat is created automatically if needed. Typing replaces the
waveform with Send. Existing chats also let you choose a speaker above the composer.
Allow the browser microphone prompt.
Voice starts in **Listen only** by default. Speak for as long as you need, including
pauses; **Your words so far** shows the incoming transcript. Playback is muted and
the server blocks new agent handoffs until you click **Respond now**. Uncheck
Listen only before starting if you prefer an ordinary conversation.

**Respond now** releases the monologue and enables replies and agent work.
**Listen only** during a conversation closes the old media/control connection and
opens a fresh listening call, preventing old buffered replies from playing later.
Already accepted agent tasks continue in the chat. Incoming transcript fragments
are saved on end/disconnection even if the provider has not finalized the turn.
Listen-only is enforced by playback and task guards; it is not a guarantee that
OpenAI stops internal generation. The current backend rejects public Realtime
turn-detection controls.

**Mute** pauses microphone input; **End call** releases the microphone and closes
the call. Switching chats, navigating away, or reloading also ends voice. Tasks
already accepted by the chat agent continue; use the existing Stop agent control
to cancel them. Completed speech transcripts are saved in the chat as voice
activity; delegated requests and agent results use the normal conversation flow.

Voice uses the chat's saved ChatGPT account (or local Codex sign-in for local
account chats), including the existing token refresh and encrypted account store.
It does not require a Platform API key. The speaker model is `gpt-live-1-codex`;
the chat's selected text model still performs delegated work in its assigned
environment. Recent voice conversation accompanies delegated requests as context.
When the chat agent is already busy, voice asks you to wait or use chat controls.

This implements OpenClaw's browser WebRTC route: audio travels between the browser
and OpenAI; PuppyGPT owns the authenticated sideband for transcripts and agent
handoffs. OAuth tokens never reach the browser. Gateway audio relay is not
implemented. Use a WebRTC-capable browser on localhost or HTTPS. Calls expire
within 30 minutes; abandoned browser sessions are closed after 45 seconds without
polling. Reconnect explicitly after a connection failure.

The subscription wire contract was checked against OpenClaw's
[`realtime-quicksilver-wire.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/openai/realtime-quicksilver-wire.ts)
and [`realtime-quicksilver.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/openai/realtime-quicksilver.ts)
on 2026-09-08: JSON call creation at
`https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
`OpenAI-Alpha: quicksilver=v2`, and sideband at
`wss://api.openai.com/v1/live/<call-id>`. This subscription protocol can change
independently of the public Realtime API. A 403 can indicate account, model, or
voice access; it does not uniquely identify which one failed.

## Signed binary releases and automatic updates

After updating `package.json` to the matching version, pushing a stable tag such
as `v0.2.0` runs `.github/workflows/release.yml`.
Actions uses Bun 1.3.11 to compile standalone binaries (including the frontend)
for Linux and macOS, x64 and arm64. It signs `manifest.json` with Ed25519 and
publishes the four binaries, manifest, and detached `manifest.sig` together.
The manifest binds the repository, version, asset names, sizes, and SHA-256 hashes.
Prereleases and non-semver tags are not accepted by the updater.

Key provisioning is intentionally separate from this implementation:

1. Embed the signing public key as an SPKI PEM string in
   `src/update/trust.ts` (`RELEASE_PUBLIC_KEY`).
2. Store the matching Ed25519 PKCS8 private PEM in the repository Actions secret
   `RELEASE_SIGNING_PRIVATE_KEY`. Never commit the private key.
3. Commit the public key and workflow before tagging a release. Signing fails if
   the secret does not match the embedded public key. The empty default key makes
   signing and automatic updates fail closed.

Run a trusted binary normally with `./puppygpt-linux-x64`, or opt into automatic
updates with `./puppygpt-linux-x64 --auto-update`. For a local build:

```bash
bun run build:binary
bun run start:auto-update
```

The supervisor polls the public GitHub repository's latest stable release on
startup and hourly thereafter. It verifies the signed manifest before downloading
the platform binary, then verifies its exact size and checksum before making it
executable. Downloads have time and size limits. Versions must increase; previously
accepted releases are reverified on supervisor startup. No keys supplied by GitHub
or environment variables are trusted.

The supervisor stays alive while restarting the app, defers activation when its
health check reports a running chat, and keeps the previous binary if the new
process fails its startup health check. A chat starting between the idle check
and shutdown can still be interrupted. Active terminals and voice sessions are
closed on restart. Rollback restores the executable only, not database migrations;
release migrations must remain compatible with the previous release. Keep normal
data backups. A crash after the startup health check requires restarting the
supervisor; run it under a process manager for unattended recovery.

`PUPPYGPT_DATA_DIR` and `PUPPYGPT_WORKDIR` remain absolute and stable across
versions. `PUPPYGPT_UPDATE_DIR` defaults to `.puppygpt/updates` and retains downloaded
versions. `PUPPYGPT_UPDATE_INTERVAL_MS` changes the polling interval (minimum one
minute). For source-based supervision, `PUPPYGPT_INITIAL_BINARY` overrides
`dist/puppygpt`. Stop any existing server on the same port before starting the
supervisor. A second supervisor using the same update directory is rejected;
after SIGKILL or a machine crash, remove `supervisor.lock` from that directory
only after confirming the old supervisor and child have stopped.

The initial binary/supervisor is the trust anchor: obtain it through a trusted
channel. The running supervisor keeps its embedded key throughout updates; key
rotation requires explicitly installing a newly trusted supervisor. Private
GitHub repositories and Windows binaries are not supported by this workflow.

The top bar shows a download icon with a green dot when a newer release is
available; hover for the version and click to open its GitHub release notes.
The browser checks while visible, with GitHub results cached server-side for
15 minutes (failed checks retry after five minutes). This indicator also works
without automatic installation enabled. Before key provisioning it reports
release availability only; after provisioning, it requires a valid signed
manifest for the current platform. It never installs an update on click.
