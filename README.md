# Agent Passport

**Sign in to your AI.**

Change machines, change agents, reinstall an agent — you never have to tell an AI who you
are again.

One account carries your identity, memory, preferences, skills, and MCP configuration
across Claude Code, OpenClaw, Codex, and Cursor.

> [!NOTE]
> Built for developers who run more than one coding agent. Those are the tools that keep
> their configuration in local files, which is the condition that makes any of this
> possible — a hosted assistant with server-side memory has nothing on disk to read.

> [!WARNING]
> Developer preview. The profile format may change before 1.0.

## The idea

Every AI agent stores the same facts about you in a different file, in a different format,
in a different directory. Install a new agent and you start over.

Agent Passport keeps one **shared memory set per person** — not one per agent — and
translates it into whatever each agent natively reads.

```
    Claude Code        OpenClaw          Codex            Cursor
    CLAUDE.md          AGENTS.md         AGENTS.md        .cursor/rules/*.mdc
    settings.json      openclaw.json     config.toml      .cursor/mcp.json
    ~/.claude.json     MEMORY.md         (TOML tables)    AGENTS.md
         ▲                  ▲                 ▲                ▲
         └──────────────────┴────────┬────────┴────────────────┘
                                 Adapters
                          import() / export()
                                     │
                        ┌────────────▼────────────┐
                        │    Universal Profile    │
                        │   + one memory store    │
                        └────────────┬────────────┘
                                     │  encrypted on this device
                        ┌────────────▼────────────┐
                        │   Encrypted cloud sync  │
                        │  (server sees nothing)  │
                        └─────────────────────────┘
```

## Install

```console
npm install -g agentpassport
```

That gives you the `agentpass` command. To try it without installing anything:

```console
npx agentpassport scan
```

Requires Node.js 22 or newer. Nothing else — no compiler, no native modules, no account.

```console
agentpass scan       # what's installed on this machine
agentpass setup      # create your passport — asks nothing, invents nothing
agentpass import     # read every agent found — no arguments needed
agentpass restore    # write your identity into every agent
```

Nothing is guessed about your setup. Agent paths are fixed and well known, so discovery is
automatic. `agentpass` on its own shows what is stored and what each agent can see.

## Getting onto a second computer

Everything above works on one machine. To carry your identity to another, tell Agent
Passport where to keep it — a private git repo is usually easiest:

```console
agentpass sync --git git@github.com:you/ai-passport.git
```

Then on the new machine, using the recovery code printed at setup:

```console
npm install -g agentpassport
agentpass setup --user-id <your-id> --git git@github.com:you/ai-passport.git --code ABCD-...
agentpass restore
```

That is the whole cross-machine story. No server to run, no account to create. The repo
only ever contains ciphertext, so it can live anywhere you can push.

Prefer a synced folder instead? `--folder ~/Dropbox/agentpass` works the same way.

## Where your data lives

Everything is a file you can inspect, move, or delete. There is no hidden state.

### On this computer — `~/.agentpass/`

| File            | Contents                                                       |
| --------------- | -------------------------------------------------------------- |
| `vault.json`    | Your profile and memories, encrypted. Plus the key slots.      |
| `device-id`     | A random id for this machine, so renaming your laptop is safe. |
| `keystore.json` | Which credential store was chosen here.                        |
| `device.key`    | Only when no OS credential store is usable (see below).        |

Inside `vault.json`, only routing metadata is readable — your user id, device name, and a
local revision log. The profile itself is ciphertext:

```json
{
  "session": { "userId": "user_8f0afaa7", "device": "workshop-mbp" },
  "keyring": { "slots": [{ "id": "device:2c09533f", "type": "device" }, { "id": "recovery" }] },
  "profile": { "body": { "iv": "QGkIW7Ue...", "ct": "5GqHZ6h2QmSxHZSX..." } }
}
```

Grep it for `pnpm`, `github`, or your API keys and you will not find them.

### In the cloud — only if you choose a sync target

Sync is off until you pick where your passport lives. Because the vault is already
ciphertext, the transport can be something you already own:

```console
agentpass sync --git git@github.com:you/ai-passport.git   # a private repo
agentpass sync --folder ~/Dropbox/agentpass               # Dropbox, iCloud, OneDrive
agentpass sync --server https://...                       # a server, if you run one
```

Whichever you choose receives one opaque document and the few fields needed to order
writes:

```json
{ "envelope": { "userId": "...", "revision": 3, "body": "<ciphertext>" }, "keyring": { ... } }
```

GitHub, Dropbox, and Apple cannot read a profile, merge one, or tell two users' preferences
apart. Merging happens on your machine, on decrypted data, field by field — the transport
only moves bytes.

A private git repo is usually the best choice for developers: nothing to run, nothing to
pay for, and a full history of every change for free.

### In your agents — only inside a fenced block

`restore` writes to the agents' own config files, and only between markers:

```
~/.claude/CLAUDE.md            ~/.openclaw/workspace/AGENTS.md
~/.claude/settings.json        ~/.openclaw/workspace/MEMORY.md
~/.claude.json                 ~/.openclaw/openclaw.json
~/.codex/config.toml           .cursor/rules/agent-passport.mdc
~/.codex/AGENTS.md             .cursor/mcp.json
```

Everything you wrote yourself is preserved byte for byte.

## Two copies, on purpose

Agent Passport keeps your configuration twice, because one copy cannot do both jobs.

| Copy           | What it is                         | What it is for                      |
| -------------- | ---------------------------------- | ----------------------------------- |
| **Normalized** | Translated into a universal schema | Moving between agents               |
| **Original**   | The source files, verbatim         | Restoring the same agent faithfully |

The normalized profile is what lets a preference learned in Claude Code appear in Cursor —
but it is a translation, and every translation loses whatever the schema does not model.
Claude Code's `permissions`, `hooks`, and `statusLine` have no universal equivalent, so a
new machine restored from the normalized copy alone would silently come up missing them.

Keeping the originals fixes that without giving up portability:

```console
$ agentpass restore claude          # on a machine with no Claude config
✓ 4 file(s) written
```

```json
{
  "model": "claude-sonnet",
  "permissions": { "allow": ["Bash(npm run test)"], "deny": ["Read(./.env)"] },
  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [...] }] },
  "statusLine": { "type": "command", "command": "~/bin/statusline.sh" }
}
```

Two rules govern the originals:

- **They never overwrite.** A file that already exists on the machine wins, because it is
  the newer copy and may hold local changes. Originals populate a fresh machine; they do
  not fight a configured one.
- **They carry no credentials.** A verbatim copy of `~/.claude.json` would otherwise
  include your live tokens. Structured values are walked during capture and anything
  credential-shaped becomes `${VAR}` indirection, so the rest of the file survives intact
  while the secret does not travel.

Files above 256KB are skipped rather than synced, with a note saying so.

### What is never stored anywhere

API keys and tokens. Agent Passport keeps a reference such as `env://GITHUB_TOKEN` or
`op://Private/openai/credential`, never the value.

## There is no passphrase

`setup` asks you for nothing. The vault key is generated for you and kept in this machine's
credential store — macOS Keychain, Windows account protection, or the Linux system keyring —
so every command afterwards just runs. Nothing to type, nothing to remember, and it works
unattended in scripts and CI.

A passphrase would have been the easy thing to build and the wrong thing to ship: it puts a
prompt in front of every command and makes losing one string mean losing everything.

Setup prints a **recovery code** once:

```
  ────────────────────────────────
     CXXA-T80X-936K-K9ST-38Q3
  ────────────────────────────────
```

That code is how a second computer joins your account. Type it once there and that machine
registers its own key, so it never asks again:

```console
agentpass setup --user-id <your-id> --server <url> --code CXXA-T80X-936K-K9ST-38Q3
```

The code is never uploaded and cannot be reissued for you. If you want a passphrase as well,
you can add one; the vault supports several independent ways to unlock the same key.

If no OS credential store is usable — a locked-down PowerShell, a headless container —
Agent Passport says so and falls back to a file only your account can read. That is weaker,
so it is named plainly rather than dressed up.

## Agents are plugins

You should not have to carry a Cursor adapter to use Claude Code. Each agent's support is a
separate, optional package, and Agent Passport works with none of them installed.

```console
npm install @agentpassport/adapter-claude
npm install @agentpassport/adapter-openclaw
npm install @agentpassport/adapter-codex
npm install @agentpassport/adapter-cursor
```

Plugins are found automatically — from `node_modules`, from `~/.agentpass/plugins/`, or
from a list in `~/.agentpass/plugins.json`. Any package named `agentpass-adapter-*` or
`@agentpassport/adapter-*` is picked up with no configuration.

Core keeps a small table of well-known agent paths, which solves a chicken-and-egg problem:
properly detecting an agent needs its adapter, but we want to tell you an agent is present
_before_ you have that adapter. So Agent Passport notices agents it cannot yet read, and
says how to fix it:

```console
$ agentpass plugins

Installed plugins
✓ Claude Code v0.1.0 (claude, bundled)

Detected here, but no plugin installed
  ● OpenAI Codex
    ~/.codex/config.toml
    npm install @agentpassport/adapter-codex

Available
  · OpenClaw — @agentpassport/adapter-openclaw
  · Cursor — @agentpassport/adapter-cursor
```

`scan` marks the same distinction, and `import`/`restore` act only on agents that are both
present and readable. A missing or broken plugin is always reported, never thrown — one bad
third-party package cannot take down the agents that do work.

## What a run looks like

```console
$ agentpass import

Claude Code
  read ~/.claude/CLAUDE.md
  read ~/.claude/settings.json
  read ~/.claude.json

  + Added MCP: github
  + Added model: coding = anthropic/claude-sonnet
  + Added workspace: packageManager = pnpm
  + Added secret reference: github.GITHUB_TOKEN -> env://GITHUB_TOKEN

✓ 2 memories captured
  2 shared with every agent
! github.env.GITHUB_TOKEN looked like a credential; stored a reference instead of the value
```

Then, on a brand-new laptop with a fresh OpenClaw install:

```console
$ agentpass login --user-id user_ming --server https://...
✓ Signed in as user_ming on laptop-B
  Joined an existing passport at revision 1.

$ agentpass restore openclaw

Found your AI identity.
✓ Identity
✓ Preferences
✓ Long-term memory (2)
✓ Skills
✓ MCP servers
✓ Workspace rules
✓ Model preferences

✓ Restored to OpenClaw (3 files)
```

## One memory set, shared by default

This is the part that matters most, so it is worth being precise about.

There is **one memory store per person**, not one per agent. Sharing is a view over that
single store, which is what makes deletion meaningful: forget something once and it is gone
from every agent, including ones you install next year.

Two independent axes govern each memory:

| Field         | Question it answers        | Example            |
| ------------- | -------------------------- | ------------------ |
| `sourceAgent` | Where did this come from?  | `claude`           |
| `sharing`     | Who is it for?             | `shared` (default) |
| `agents`      | If narrowed, which agents? | `['claude']`       |

A fact about you is true everywhere, so **`shared` is the default**. Only text about one
agent's own machinery — its slash commands, its settings file, its tool names — is pinned
to that agent, because it is meaningless noise elsewhere.

```console
$ agentpass memory list

Memory — one store, 2 active
2 shared with every agent, 0 agent-specific

  mem_18f113cf  I prefer pnpm over npm for all projects.
    preference · all agents · from claude · imported · confidence 0.85
```

```console
agentpass memory pin mem_18f113cf claude    # narrow it to one agent
agentpass memory share mem_18f113cf         # widen it again
agentpass memory forget mem_18f113cf        # delete from every agent at once
```

`agentpass status` shows the resulting audience per agent:

```
Agents
✓ Claude Code — sees 2 memories
✓ OpenClaw    — sees 1 memory
```

## Memory is not automatically trusted

An agent reading a web page, an email, or a README is not you speaking. If that text became
permanent memory, a sentence on a page could quietly rewrite your identity across every
agent you own.

Every memory therefore carries a provenance, and provenance decides what happens:

| Provenance         | Meaning                              | Result                          |
| ------------------ | ------------------------------------ | ------------------------------- |
| `user_explicit`    | You said it                          | Active                          |
| `imported`         | From config files you wrote yourself | Active                          |
| `agent_inferred`   | An agent concluded it                | Active above 0.85 confidence    |
| `external_content` | Web page, email, PDF, README         | Never auto-promoted to identity |
| `system_generated` | Produced by Agent Passport           | Active                          |

`external_content` can never become identity memory without you approving it, and anything
that looks like a credential is refused outright.

## Secrets are never stored

Agent Passport stores a **reference**, never the material:

```yaml
secrets:
  provider: 1password
  references:
    openai: op://Private/openai/credential
```

When an import finds an inline API key in an MCP server definition, the value is dropped at
the boundary and replaced with a pointer. Your key stays exactly where it already was.

On export, references become shell indirection rather than resolved values, so a config
file that gets committed or backed up never becomes a new place a secret lives:

```json
{ "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
```

Supported schemes: `op://` (1Password CLI), `infisical://` (Infisical CLI), `env://`.

## Encryption

Your profile is encrypted on your device before it touches disk or network, with
AES-256-GCM.

The design assumes the server is eventually compromised. It stores an opaque blob and the
metadata needed to order writes — a user id, a revision, a timestamp — and nothing else. A
full database breach yields ciphertext.

Envelope encryption is what makes this practical. A random **data key** protects the
profile, and that key is then wrapped several independent ways — one slot per unlock method:

| Slot       | Wrapped by                        | Used for                       |
| ---------- | --------------------------------- | ------------------------------ |
| Device     | A key in your OS credential store | Every command, silently        |
| Recovery   | Your recovery code                | Adding a computer, or recovery |
| Passphrase | A passphrase, if you add one      | Optional                       |

Every slot opens the same data key, so daily use costs nothing and a second machine only
needs the code once. The wrapped key syncs with the profile and is useless without one of
those secrets, none of which are ever uploaded.

Device slots merge on sync rather than overwrite, so two computers never knock each other
out of the account.

> [!IMPORTANT]
> The recovery code is never uploaded and nobody can reissue it. Lose it along with your
> registered machines and the profile is unreadable — that is the point.

## Commands

| Command                                   | Purpose                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `agentpass`                               | What is stored and which agents can see it         |
| `agentpass scan`                          | List detected agents and their config files        |
| `agentpass plugins`                       | Which adapters are installed, missing, or broken   |
| `agentpass setup`                         | Create a passport, or join one with `--code`       |
| `agentpass import [agent]`                | Agent config → passport (all agents by default)    |
| `agentpass restore [agent]`               | Passport → agent config (all agents by default)    |
| `agentpass snapshot [agent]`              | Encrypted per-agent folder backup (see below)      |
| `agentpass hydrate [agent]`               | Restore a snapshot back to disk                    |
| `agentpass diff [agent]`                  | Show both directions, change nothing               |
| `agentpass sync`                          | Reconcile with your other computers                |
| `agentpass sync --git \| --folder`        | Choose where your passport is kept                 |
| `agentpass status`                        | Passport, memory audience, and secret reachability |
| `agentpass memory list`                   | Inspect the shared store                           |
| `agentpass memory share \| pin \| forget` | Control who sees what                              |
| `agentpass logout`                        | Remove the passport from this computer             |

`import` and `restore` accept `--dry-run`. `restore` always previews and asks before
writing.

### Snapshot mode — per-agent folder backup

`import`/`restore` translate config through a universal profile so agents can share
settings. That is the right model when you want cross-agent memory sharing.

`snapshot`/`hydrate` are the opposite trade-off: each agent gets its own encrypted
folder, files stored verbatim, no translation, no sharing. Use this when you just
want to back up an agent (identity files, memory, config, skills) and restore it
intact on another machine or after a wipe.

```bash
agentpass snapshot                # snapshot every known agent
agentpass snapshot openclaw       # single agent
agentpass snapshot --diff         # show what changed since last snapshot
agentpass snapshot --dry-run      # no writes
agentpass snapshot --push         # git commit + push after writing

agentpass hydrate openclaw        # restore back to disk
agentpass hydrate --prune         # delete files not in the snapshot
agentpass hydrate --dry-run       # preview target paths
```

Snapshots live at `~/.agentpass/agents/<agent>/snapshot.enc.json`, encrypted with
the same data key as the vault. Each agent has an explicit manifest of what to
capture (persona files, memory, config, skills) and what to exclude (session
transcripts, logs, secrets, `.git`, `node_modules`). Supported today: openclaw,
claude, codex, cursor.

## How your files are treated

Agent Passport writes only inside a fenced block:

```markdown
<!-- BEGIN AGENT PASSPORT -->

...managed content...
<!-- END AGENT PASSPORT -->
```

Everything outside it is yours and is preserved byte for byte. JSON and TOML settings are
merged key by key, so options Agent Passport does not model survive untouched. Writes are
atomic, and exporting twice produces an identical file.

## Adding an agent

Publish a package named `agentpass-adapter-<name>`. It is discovered automatically — no
change to this repository, and no new release of the CLI.

Implement one interface and export a plugin manifest:

```ts
import { ADAPTER_API_VERSION, definePlugin } from '@agentpassport/adapter-sdk';

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;

  detect(context: AdapterContext): Promise<boolean>;
  import(context: AdapterContext, userId: string): Promise<ImportResult>;
  previewExport(
    context: AdapterContext,
    profile: UniversalProfile,
    memories?: MemoryRecord[],
  ): Promise<AgentConfigDiff>;
  export(
    context: AdapterContext,
    profile: UniversalProfile,
    memories?: MemoryRecord[],
  ): Promise<ExportResult>;
  validate(context: AdapterContext): Promise<ValidationResult>;
}

export const plugin = definePlugin({
  apiVersion: ADAPTER_API_VERSION,
  id: 'my-agent',
  displayName: 'My Agent',
  create: () => new MyAgentAdapter(),
});
```

`apiVersion` is checked at load time, so an adapter built against an older interface is
refused with a clear message instead of half-working and corrupting someone's config on the
first `restore`.

Adapters must be bidirectional and idempotent. `import` after `export` round-trips, and
`export` twice is a no-op. A one-way copier would strand users on whichever agent they
configured first, which is the trap this exists to avoid.

Adapters never touch `process.env` or `os.homedir()` directly; everything comes through
`AdapterContext`, which is what lets the test suite run every adapter against a temporary
directory instead of a developer's real configuration.

## Repository layout

| Path                   | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `packages/profile`     | `UniversalProfile` schema, field versioning, YAML codec    |
| `packages/memory`      | Memory schema, provenance policy, sharing resolution       |
| `packages/crypto`      | AES-256-GCM sealed boxes, keyring, envelopes               |
| `packages/adapter-sdk` | `AgentAdapter` interface, plugin contract, building blocks |
| `packages/sync`        | Field-level diff, three-way merge, conflict detection      |
| `packages/core`        | Encrypted vault, plugin loader, orchestration, discovery   |
| `adapters/*`           | Optional plugins: Claude Code, OpenClaw, Codex, Cursor     |
| `integrations/mem0`    | Optional Mem0-backed memory provider                       |
| `integrations/secrets` | 1Password, Infisical, and environment resolvers            |
| `apps/cli`             | The `agentpass` command                                    |
| `apps/api`             | Reference zero-knowledge sync server                       |

## Memory backends

By default memories live in the encrypted vault and sync with your profile, so portability
requires no third-party account.

Set `MEM0_API_KEY` and `memory.provider: mem0` to use [Mem0](https://mem0.ai) instead, which
adds retrieval and deduplication. Agent Passport implements neither itself; the provenance
and sharing fields ride along in Mem0 metadata.

## Running your own sync server

Optional. `--git` and `--folder` cover the same need with nothing to operate; this exists
for teams who want the data on their own infrastructure.

```console
node apps/api/dist/server.js
```

| Variable              | Default               | Purpose                    |
| --------------------- | --------------------- | -------------------------- |
| `AGENTPASS_API_HOST`  | `127.0.0.1`           | Bind address               |
| `AGENTPASS_API_PORT`  | `4100`                | Port                       |
| `AGENTPASS_API_DATA`  | `./.agentpass-server` | Where ciphertext is stored |
| `AGENTPASS_API_TOKEN` | unset (open)          | Required bearer token      |

This reference server stores files and checks a static token. Swap the filesystem for
Postgres and the token for a real identity provider; the contract does not change.

## Environment

| Variable               | Purpose                                     |
| ---------------------- | ------------------------------------------- |
| `AGENTPASS_HOME`       | Passport directory (default `~/.agentpass`) |
| `AGENTPASS_AGENT_HOME` | Home directory agents are read from         |
| `AGENTPASS_SERVER`     | Sync server URL                             |
| `AGENTPASS_DEVICE`     | Device name recorded in change metadata     |
| `MEM0_API_KEY`         | Enable the Mem0 memory backend              |

## Development

```console
git clone https://github.com/agentpassport/agentpassport && cd agentpassport
npm install
npm run build
npm link --workspace agentpassport
```

Run against a fake home so you never touch your real agent configuration:

```console
$env:AGENTPASS_AGENT_HOME = "$env:TEMP\demo-home"   # pretend HOME for agents
$env:AGENTPASS_HOME       = "$env:TEMP\demo-pass"   # where the passport lives
```

On macOS or Linux use `export` instead of `$env:`.

```console
npm run build
npm test
npm run check
```

The test suite runs every adapter against temporary directories, so it never reads or
writes your real agent configuration.

### Releasing

```console
npm run release:dry     # rewrite workspace versions, build, and dry-run publish
npm run release         # the real thing
```

Workspace dependencies are written as `*` while developing, which npm cannot resolve from
the registry. `release:prepare` rewrites them to the current version and fills in the
publish metadata, so a release is one command rather than a checklist.

## License

Apache License 2.0.
