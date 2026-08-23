# Agent Passport

**Sign in to your AI.**

One account carries your identity, memory, preferences, skills, and MCP config
across Claude Code, OpenClaw, Codex, and Cursor. Change machines, change agents,
reinstall an agent — you never have to tell an AI who you are again.

> [!WARNING]
> Developer preview. The profile format may change before 1.0.

## Install

```console
npm install -g agentpassport   # or: npx agentpassport scan
```

Requires Node.js 22+. Nothing else — no compiler, no native modules, no account.

## Quick start

```console
agentpass scan               # what's installed on this machine
agentpass setup              # create your passport
agentpass snapshot           # encrypted per-agent backup
agentpass hydrate <agent>    # restore a snapshot back to disk
```

`setup` gives you a recovery code. That code is the only way to get your identity
onto another computer, or back if this one is lost. It is never uploaded.

## Two modes

| Mode                       | What it does                                  |
| -------------------------- | --------------------------------------------- |
| `snapshot` / `hydrate`     | Per-agent encrypted folder backup, verbatim   |
| `import` / `restore`       | Translated universal profile, cross-agent     |

**Snapshot** — each agent gets its own encrypted folder at
`~/.agentpass/agents/<agent>/snapshot.enc.json`. Files stored verbatim, no
translation. Use when you just want to back an agent up and put it back intact.
Supported: openclaw, claude, codex, cursor.

```bash
agentpass snapshot [agent]    # flags: --diff --dry-run --push
agentpass hydrate  [agent]    # flags: --prune --dry-run
```

**Import/restore** — translates each agent's config into a universal profile so
preferences learned in one agent appear in another. Originals are also kept so a
fresh machine can be restored faithfully.

## Sync

```console
agentpass sync --git git@github.com:you/your-passport.git
agentpass sync --folder ~/Dropbox/passport
```

Everything is encrypted with a data key that never leaves the device. The sync
target only ever sees ciphertext.

## Where your data lives

- `~/.agentpass/vault.json` — keyring + encrypted profile (safe to sync)
- `~/.agentpass/agents/<agent>/snapshot.enc.json` — encrypted per-agent backup
- `~/.agentpass/device.key`, `device-id`, `keystore.json` — **machine-local, never sync**

Excluded from snapshots: session transcripts, logs, `.secrets/`, `.git`,
`node_modules`, anything credential-shaped.

## Commands

| Command                       | Purpose                                    |
| ----------------------------- | ------------------------------------------ |
| `agentpass`                   | What is stored and which agents can see it |
| `agentpass scan`              | List detected agents                       |
| `agentpass plugins`           | Which adapters are installed               |
| `agentpass setup`             | Create a passport, or join with `--code`   |
| `agentpass import [agent]`    | Agent config → passport                    |
| `agentpass restore [agent]`   | Passport → agent config                    |
| `agentpass snapshot [agent]`  | Encrypted per-agent folder backup          |
| `agentpass hydrate [agent]`   | Restore a snapshot back to disk            |
| `agentpass diff [agent]`      | Show both directions, change nothing       |
| `agentpass sync`              | Reconcile with your other computers        |
| `agentpass status`            | Passport, memory audience, secrets         |
| `agentpass memory list`       | Inspect the shared store                   |
| `agentpass logout`            | Remove the passport from this computer     |

## Secrets

API keys and tokens are never stored. Agent Passport keeps a reference such as
`env://GITHUB_TOKEN` or `op://Private/openai/credential`, never the value.

## Encryption

- AES-256-GCM for content
- Argon2id (or scrypt fallback) for passphrase-derived keys
- Per-device key sealed by the vault key; loss of a device does not require a
  password reset, only removing that device's slot

## Adding an agent

Adapters live in `adapters/`. Each exports a small `AgentAdapter` and a
`snapshotEntries(paths)` function listing which files belong in a backup. See
`adapters/openclaw` for the reference implementation.

## Repository layout

```
apps/cli              CLI entry point
packages/core         Passport, store, plugin loader
packages/crypto       Keyring, envelope, KDF
packages/adapter-sdk  Types + snapshot helpers
adapters/*            Per-agent adapters
```

## Development

```console
npm install
npm run build
npm test
```

## License

MIT
