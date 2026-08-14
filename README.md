# dsh-project-mcp-bridge

A host-plane DSH plugin that loads **MCP servers per project**. Drop a
`.dsh/mcp.json` (the `mcpServers` JSON shape shared by Claude Code, Cursor
and VS Code) into a project root, and every session of that project
automatically gets the servers' tools as `mcp__<serverName>__<rawName>`.

This is a **client bridge** — it consumes MCP servers. It is not an MCP
server, and it is not an official DeepSeek package.

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

1. The plugin row must be present in the host composition's user patch
   layer (`~/.dsh/profiles/web/cordis.patch.yml`):

   ```yaml
   - insert:
       - id: dsh-project-mcp-bridge
         name: 'file:///C:/Users/KYin/.dsh/profiles/web/plugins/dsh-project-mcp-bridge/index.mjs'
   ```

   The user patch layer is hot-reloaded (HMR): saving the file takes
   effect in ~4 s — no process restart. To reload after editing the plugin
   module itself, bump the `?v=N` query on the `name` URL (HMR watches the
   patch file, not the plugin file; a changed URL forces the row to reload).

2. Restart is only needed if the patch file is added before the HMR
   watcher was ever running (i.e. at first boot).

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

- **Config hot-reload is live (v2)**: saving `.dsh/mcp.json` re-resolves
  the config for every running session of that project and swaps
  generations — added servers gain tools, removed servers lose them,
  changed servers reconnect (same serverName keeps stable tool names, so
  recorded calls stay replayable). A deleted config unloads everything.
  No new session needed.
- Resources and prompts from MCP servers are not bridged (tools only).
- Connections are shared per (projectRoot, serverName): sessions of the
  same project share one connection; it closes when the last session
  releases it.
- Streaming/task-based MCP execution is not supported (call only).
