# Agent Passport

**Sign in to your AI.**

Change machines, change agents, reinstall an agent — you never have to tell an AI who you
are again.

One account carries your identity, memory, preferences, skills, and MCP configuration
across Claude Code, OpenClaw, Codex, and Cursor.

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

## Quick start (5 minutes)

Requires Node.js 22+.

```console
git clone <this-repo> && cd agentpassport
npm install
npm run build
```

Link the CLI so `agentpass` is on your PATH:

```console
npm link --workspace agentpass
```

Then:

```console
agentpass scan       # what's installed on this machine
agentpass login      # create an encrypted passport
agentpass import     # read every agent found — no arguments needed
agentpass restore    # write your identity into every agent
```

Nothing is guessed about your setup. Agent paths are fixed and well known, so discovery is
automatic.

### Try it without touching your real config

```console
$env:AGENTPASS_AGENT_HOME = "$env:TEMP\demo-home"   # pretend HOME for agents
$env:AGENTPASS_HOME       = "$env:TEMP\demo-pass"   # where the passport lives
```

On macOS or Linux use `export` instead of `$env:`.

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
AES-256-GCM under a scrypt-derived key.

The design assumes the server is eventually compromised. It stores an opaque blob and the
metadata needed to order writes — a user id, a revision, a timestamp — and nothing else. A
full database breach yields ciphertext.

Envelope encryption makes multiple devices work: a random data key protects the profile,
and your passphrase only protects the data key. The wrapped key syncs with the profile, so
a second device with the same passphrase can join. The server can never unwrap it.

> [!IMPORTANT]
> The passphrase is never uploaded and cannot be recovered. Lose it and the profile is
> unreadable — that is the point.

## Commands

| Command                                              | Purpose                                            |
| ---------------------------------------------------- | -------------------------------------------------- |
| `agentpass scan`                                     | List detected agents and their config files        |
| `agentpass login`                                    | Create or join a passport                          |
| `agentpass import [agent]`                           | Agent config → passport (all agents by default)    |
| `agentpass restore [agent]`                          | Passport → agent config (all agents by default)    |
| `agentpass diff [agent]`                             | Show both directions, change nothing               |
| `agentpass sync`                                     | Reconcile this machine with the cloud              |
| `agentpass status`                                   | Passport, memory audience, and secret reachability |
| `agentpass memory list`                              | Inspect the shared store                           |
| `agentpass memory share \| pin \| approve \| forget` | Control who sees what                              |
| `agentpass logout`                                   | Remove the local passport                          |

`import` and `restore` accept `--dry-run`. `restore` always previews and asks before
writing.

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

Implement one interface and register it. Nothing else changes — not the profile schema, not
the sync engine, not the CLI.

```ts
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
```

Adapters must be bidirectional and idempotent. `import` after `export` round-trips, and
`export` twice is a no-op. A one-way copier would strand users on whichever agent they
configured first, which is the trap this exists to avoid.

Register it in `packages/core/src/registry.ts`:

```ts
new AdapterRegistry().register(claudeAdapter).register(yourAdapter);
```

## Repository layout

| Path                   | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `packages/profile`     | `UniversalProfile` schema, field versioning, YAML codec |
| `packages/memory`      | Memory schema, provenance policy, sharing resolution    |
| `packages/crypto`      | AES-256-GCM sealed boxes, keyring, envelopes            |
| `packages/adapter-sdk` | `AgentAdapter` interface and adapter building blocks    |
| `packages/sync`        | Field-level diff, three-way merge, conflict detection   |
| `packages/core`        | Encrypted vault, orchestration, discovery               |
| `adapters/*`           | Claude Code, OpenClaw, Codex, Cursor                    |
| `integrations/mem0`    | Optional Mem0-backed memory provider                    |
| `integrations/secrets` | 1Password, Infisical, and environment resolvers         |
| `apps/cli`             | The `agentpass` command                                 |
| `apps/api`             | Reference zero-knowledge sync server                    |

## Memory backends

By default memories live in the encrypted vault and sync with your profile, so portability
requires no third-party account.

Set `MEM0_API_KEY` and `memory.provider: mem0` to use [Mem0](https://mem0.ai) instead, which
adds retrieval and deduplication. Agent Passport implements neither itself; the provenance
and sharing fields ride along in Mem0 metadata.

## Running the sync server

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
| `AGENTPASS_PASSPHRASE` | Non-interactive passphrase for CI           |
| `AGENTPASS_SERVER`     | Sync server URL                             |
| `AGENTPASS_DEVICE`     | Device name recorded in change metadata     |
| `MEM0_API_KEY`         | Enable the Mem0 memory backend              |

## Development

```console
npm run build
npm test
npm run check
```

The test suite runs every adapter against temporary directories, so it never reads or
writes your real agent configuration.

## License

Apache License 2.0.
