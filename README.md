# dsh-project-mcp-bridge

[English](README.md) | [中文](README.zh.md)

> **TL;DR** — Let each project declare its own MCP servers. Drop a
> `.dsh/mcp.json` into a project root; every session of that project then
> has those servers' tools (`mcp__<serverName>__<toolName>`), and editing
> the file takes effect **live** — no new session, no restart.
>
> It is a **client bridge** (consumes MCP servers). Not an MCP server, not
> an official DeepSeek package.

## 30-second demo

```jsonc
// MyProject/.dsh/mcp.json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

Then, in any session opened in `MyProject`, the model can directly call
`mcp__github__create_issue` etc. — the same `mcpServers` JSON shape used by
Claude Code, Cursor and VS Code. Save the file again later and running
sessions pick the change up within ~1 s.

Install once: `dsh plugin --profile web add dsh-project-mcp-bridge` (one
restart), or see [Installation](#installation) for the restart-free dev
path.

---

## How it works

```
agent created (agent/created)
  -> read <session cwd>/.dsh/mcp.json
  -> for each server entry:
       - if a preset/host MCP row already provides the same serverName
         and the entry has no "override": true  -> skip (log explains why)
       - else connect (stdio spawn or streamable-http)
       - list tools, register each as mcp__<serverName>__<rawName>
         into the AGENT scope layer only (project > preset > host)
  -> connections are pooled per (projectRoot, serverName) and shared
     across sessions of the same project; the pool closes when the last
     session releases it
```

## Installation

The package is a **profile bundle**: install with the dsh CLI, no manual
patching.

```bash
dsh plugin --profile web add dsh-project-mcp-bridge
```

`dsh plugin` runs pnpm in the profile directory, then reconciles
`dsh.profile.bundles`: the package declares `dsh.bundle.patch`, so it joins
the profile's bundle layers automatically. The bundle's own
`cordis.patch.yml` supplies the plugin row — nothing to add by hand.

**Restart `dsh web` once** after installing: bundle layers are composed at
startup (only the user patch layer and `settings.yaml` are hot-reloaded).
After that, `.dsh/mcp.json` changes are hot (see Config hot-reload).

### Restart-free dev path (hot install)

If you iterate on this plugin itself and want changes live without
restarts, install it as a **user patch row** instead of a bundle. The row
references the package by **name** (resolved from the profile's
`node_modules`), so it is portable and hot:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-project-mcp-bridge          # package into node_modules (no reconcile)
```

Then append to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-project-mcp-bridge
      name: 'dsh-project-mcp-bridge'     # package name, NOT a file:// path
```

The user patch layer is hot-reloaded (~4 s), so the row activates without
a restart. Note: do NOT use `dsh plugin add` for this path — it would also
register the bundle and duplicate the row after the next restart. Prefer
the bundle install for normal use; this path is for local iteration.

## Project config

Create `.dsh/mcp.json` at the project root (the file's presence is the
opt-in; sessions of projects without it are untouched):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "local-api": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "override": true
    }
  }
}
```

### Fields (same names as dsh-mcp-client)

| Field | Transport | Required | Meaning |
|---|---|---|---|
| `transport` | both | — | inferred: `command` present → stdio; `url` present → streamable-http; exactly one of the two |
| `serverName` | both | yes | tool namespace (the JSON key); `[A-Za-z0-9_-]{1,32}` |
| `command` | stdio | yes | executable to spawn |
| `args` | stdio | no | arguments |
| `env` | stdio | no | extra environment, merged over the scrubbed parent env |
| `cwd` | stdio | no | child working directory (relative paths resolve against the project root) |
| `url` | http | yes | MCP server URL |
| `headers` | http | no | extra headers |
| `toolCallTimeoutMs` | both | no | per-call timeout (default 60000) |
| `override` | both | no | force this project connection even if a preset/host row already provides the same serverName (default false) |

`${NAME}` placeholders in `env`/`headers` values are expanded from the
host process environment.

## Conflict semantics (project vs. preset/host MCP)

- Tools register into the **agent** scope layer; the layered registry
  shadows same-named tools from the preset layer and the global layer —
  visibility priority is **project > preset > host**.
- A `serverName` already provided by a preset/host row is **skipped by
  default** (one live connection per server). Set `"override": true` to
  force the project connection instead (double connection accepted,
  project tools win).
- Different serverNames or different tool names coexist freely.

## Config hot-reload (v2)

Saving `.dsh/mcp.json` re-resolves the config for **every running session**
of that project and swaps generations live:

- **added server** → connect + register tools (running sessions gain them)
- **removed server** → unregister tools + release the pooled connection
- **changed server** → teardown the old generation, connect the new one —
  same serverName keeps the same public tool names, so recorded tool calls
  stay replayable
- **deleted config** → all project MCP tools unload

No new session needed. The file is polled (`fs.watchFile`, ~500 ms) with a
300 ms debounce. Reconnect happens per server; an in-flight tool call on a
server being reconfigured may be interrupted by the swap.

## Environment scrubbing (privilege reduction)

MCP children are spawned with the official `scrubbedParentEnv()`: the
ambient environment minus credential-shaped names (anything matching
`KEY|PASSWORD|SECRET|TOKEN`) and minus stale `DSH_*` names. `PATH`, `HOME`
and locale survive, so children run normally; secrets that merely happen
to be in the host environment are NOT inherited. Only the entry's explicit
`env` is added back. This is not a sandbox: a malicious config can still
execute code as your user and read your files (see Trust model).

## Trust model ⚠️

`.dsh/mcp.json` contains **executable content** — the same trust model as
`package.json` scripts. A `git clone` can bring its own `.dsh/mcp.json`
(just as it can bring a malicious `postinstall`), and opening the project
will run it when a session is created. Only open projects from sources you
trust. The plugin reduces blast radius (scrubbed env, auditable logs) but
does not and cannot make untrusted projects safe.

## Logging

- `ctx.logger` (host stdout — not persisted by this deployment)
- `~/.dsh/logs/dsh-project-mcp-bridge/dsh-project-mcp-bridge.log`
  (append-only; every step — config read, skip reason, connect, tool
  registration, close — is recorded with a timestamp and the project path)

## Limitations

- Resources and prompts from MCP servers are not bridged (tools only).- Connections are shared per (projectRoot, serverName): sessions of the
  same project share one connection; it closes when the last session
  releases it.
- Streaming/task-based MCP execution is not supported (call only).

## Further reading

- [Design notes: DSH philosophy and this plugin's alignment](docs/design-notes.md) ·
  [设计笔记（中文）](docs/design-notes.zh.md) — why DSH is layered the way
  it is, its trust model, the hot-reload boundary, and why project-level MCP
  is a plugin's job.
