# Agent Passport

**Encrypted, per-agent config backup for AI coding tools.**

One CLI, one recovery code, snapshots every known agent's config to an encrypted
folder you can push to a private git repo. Change machines, wipe a laptop,
reinstall an agent — pull the snapshot back and you are exactly where you left off.

> [!WARNING]
> Developer preview. Snapshot format may change before 1.0.

## Install

```console
npm install -g agentpassport
```

Requires Node.js 22+. No compiler, no native modules, no account.

## Quick start

```console
agentpass setup                       # create your local vault + recovery code
agentpass scan                        # what's installed here
agentpass snapshot openclaw           # encrypted backup of one agent
agentpass snapshot                    # backup every detected agent
agentpass hydrate openclaw --dry-run  # preview restore
```

`setup` prints a recovery code once. It is the only way to unlock the vault on
another machine. It is never uploaded.

## How it works

Each agent gets its own encrypted snapshot:

```
~/.agentpass/agents/<agent>/snapshot.enc.json
```

Files are stored verbatim — no translation, no schema, no cross-agent sharing.
`hydrate` writes them back to the exact paths they came from.

Supported adapters: `openclaw`, `claude`, `codex`, `cursor`. Each ships only a
`paths.ts` describing which files belong in its snapshot.

## Sync

Snapshots + vault push through any of these backends:

```console
agentpass snapshot --push             # uses the sync target from setup
```

Configure a target once (git, folder, or http). The target only ever sees
ciphertext.

## Where your data lives

- `~/.agentpass/vault.json` — keyring + session (safe to sync)
- `~/.agentpass/agents/<agent>/snapshot.enc.json` — encrypted per-agent backup
- `~/.agentpass/device.key`, `device-id`, `keystore.json` — **machine-local, never sync**

## Commands

| Command                       | Purpose                                    |
| ----------------------------- | ------------------------------------------ |
| `agentpass`                   | Show status                                |
| `agentpass setup`             | Create a passport, or join with `--code`   |
| `agentpass status`            | What is stored on this machine             |
| `agentpass scan`              | List detected agents                       |
| `agentpass plugins`           | Which adapters are installed               |
| `agentpass snapshot [agent]`  | Encrypted per-agent backup (`--diff --dry-run --push`) |
| `agentpass hydrate  [agent]`  | Restore a snapshot back to disk (`--prune --dry-run`) |
| `agentpass logout`            | Remove the passport from this computer     |

## Encryption

- AES-256-GCM for content
- Argon2id (or scrypt fallback) for the recovery code
- Per-device key sealed by the vault key and stored in the OS credential store
- Losing a device only means removing that device's keyring slot

## Adding an agent

Adapters live in `adapters/`. Each one exports:

```ts
export interface AdapterPaths { /* absolute paths for this agent */ }
export function <agent>Paths(ctx): AdapterPaths;
export function snapshotEntries(paths): string[];  // files/dirs in the backup
```

See `adapters/openclaw` for the reference implementation.

## Repository layout

```
apps/cli              CLI entry point (agentpass)
packages/core         Passport, vault store, plugin loader
packages/crypto       Keyring, envelope, KDF
packages/adapter-sdk  Snapshot helpers + shared types
adapters/*            Per-agent adapters (paths only)
```

## Development

```console
npm install
npm run build
npm test
```

## License

MIT
