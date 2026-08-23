# Agent Passport

**Per-agent config backup for AI coding tools, synced to a git repo you own.**

One CLI. Each agent's files are stored verbatim under `~/.agentpass/agents/<agent>/`
and pushed to a private git repo. Change machines, wipe a laptop, reinstall an
agent — clone the repo back and restore. No encryption layer, no recovery code,
no lock-in: your backup is just files you can `cat`, `git diff`, and `cp`.

> [!WARNING]
> Developer preview. Snapshot format may change before 1.0.

## Install

```console
npm install -g agentpassport
```

Requires Node.js 22+. No compiler, no native modules, no account.

## Quick start

The whole flow. Substitute your own repo URL for `<git-url>` — anything you can
`git push` to (private GitHub / GitLab / self-hosted) works.

**1. Create an empty private repo.**
   You own it; the CLI just pushes to it. Nothing else needs to exist there.

**2. First-time setup on this machine:**

```console
agentpass setup                       # create local passport
agentpass remote <git-url>            # bind + initial push
agentpass snapshot --push             # back up every detected agent
```

`agentpass remote` handles `git init`, sets `origin`, does the first commit and
push. Run it once per machine.

**3. Daily use — change something, back it up:**

```console
# edit ~/.openclaw/workspace/MEMORY.md, etc.
agentpass snapshot --push        # only pushes if something actually changed
```

**4. New machine / disaster recovery:**

```console
git clone <git-url> ~/.agentpass
agentpass restore                # write every agent's files back to disk
```

That's it.

## How it works

Each agent's files go into `~/.agentpass/agents/<agent>/`:

```
agents/openclaw/
├── files/                                # verbatim copies at their original relative paths
│   ├── openclaw.json
│   └── workspace/
│       ├── AGENTS.md
│       ├── MEMORY.md
│       └── memory/2026-08-23.md
└── snapshot.json                         # hash + capturedAt + file list
```

- **`snapshot`** collects the files described by the agent's adapter and mirrors
  them into `files/`. Content hash decides whether anything gets rewritten.
- **`restore`** copies `files/` back to the paths they came from.
- **`remote`** binds the whole `~/.agentpass/` directory to a git remote.
- **`--push`** on `snapshot` runs `git add / commit / push` when there's a diff.

Supported adapters: `openclaw`, `claude`, `codex`, `cursor`. Each ships only a
`paths.ts` describing which files belong in its snapshot — no schema, no
translation, no cross-agent sharing.

## Commands

| Command                                       | Purpose                                          |
| --------------------------------------------- | ------------------------------------------------ |
| `agentpass`                                   | Show status                                      |
| `agentpass setup`                             | Create a local passport                          |
| `agentpass remote [<git-url>] [--branch main]`| Bind passport home to a git repo (or show it)    |
| `agentpass status`                            | What is stored on this machine                   |
| `agentpass scan`                              | List detected agents                             |
| `agentpass plugins`                           | Which adapters are installed                     |
| `agentpass snapshot [agent]`                  | Per-agent backup (`--diff --dry-run --push`)     |
| `agentpass restore  [agent]`                  | Restore a snapshot to disk (`--prune --dry-run`) |
| `agentpass logout`                            | Remove the passport from this computer           |

## Where your data lives

- `~/.agentpass/agents/<agent>/files/` — plain-text copies of the agent's files
- `~/.agentpass/agents/<agent>/snapshot.json` — manifest (hash, file list)
- `~/.agentpass/vault.json` — local session/keyring metadata
- `~/.agentpass/device.key`, `device-id`, `keystore.json` — machine-local, gitignored

Because backups are plain files, you get every git tool for free: `git log
agents/openclaw/files/workspace/MEMORY.md`, GitHub's blame view, `git revert`.
Security comes from your repo being private, not from a wrapping crypto layer.

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
packages/crypto       Keyring, envelope, KDF (used by vault, not snapshots)
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
