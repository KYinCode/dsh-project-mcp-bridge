# DSH design philosophy and how this plugin aligns (Design notes)

> Community observations, assembled from reading the deepseek-harness source
> and docs — not official documentation. Purpose: explain *why DSH is
> designed this way* and *why this plugin looks the way it does*, so readers
> understand the trade-offs instead of fighting the boundaries.

## 1. Everything is a plugin: two planes

DSH compositions live on two planes:

| Plane | Contents | Lifetime |
|---|---|---|
| **Host composition** | Registries (tools/agents/skills), sandbox & approval stack, persistence, model routing, subagent registry | process-wide, one instance |
| **Agent preset** | One session's capability surface: tool rows, persona, prompt sections, skills | mounted/unmounted with the session |

The tool registry is layered by **scope**: `agent → preset → global`, nearer
shadows farther. That layering is the mechanism behind the
`project > preset > host` visibility priority — this plugin registers MCP
tools into the **agent layer** precisely to respect it: project config
affects only its own sessions, never the global surface.

## 2. Trust model: capability equals trust

- **A preset IS a composition**: a `user` preset's permissions equal the
  plugins it names — shell-access level. `trust: system` (shipped, read-only)
  vs `trust: user` (authorable) exists to present the difference, not to
  enforce isolation.
- **Project directories are a content zone, not a trust zone**: DSH lets
  projects carry `.dsh/skills`, `.agents/skills`, `AGENTS.md` — all prompt
  text (the model can weigh and refuse it). There is **no official entry
  for executable configuration** in a project directory.
- **Corollary**: project-level MCP (`command`/`env` spawns processes) is
  *executable content* — same trust as `package.json` scripts. The most
  likely reason upstream does not build it in is exactly this: it would make
  a trust statement on the user's behalf. Presets are the official answer
  ("capability bound to an explicit choice"), not "capability bound to the
  unthinking act of opening a directory".
- **How this plugin aligns**: `.dsh/mcp.json` is an **opt-in file** (loaded
  only when present); children run with the official `scrubbedParentEnv()`
  (credential-shaped variables are not inherited); every step goes to an
  **auditable log**; the README states the trust model plainly ("same trust
  as package.json scripts"). Blast radius shrunk — but no claim of sandboxing
  supply-chain attacks.

## 3. Hot-reload boundary: what is hot, what is cold, and why

| Layer | Change | Hot? | Mechanism |
|---|---|---|---|
| `settings.yaml` | user settings | ✅ | documented hot-reload in the base composition |
| user patch layer (`cordis.patch.yml`) | add/change/remove rows | ✅ ~4s | `watchUserPatches` → `hmr.registerConfig` → include `entry.update` |
| dynamic plugins | define/activate/unmount | ✅ fully | `cordis_run` / `cordis_stop` (in-process) |
| `.dsh/mcp.json` | project config | ✅ ~1s | this plugin's `fs.watchFile` + generation swap |
| **bundle list** (`dsh.profile.bundles`) | `dsh plugin add/remove` | ❌ **restart** | `composeProfile` at startup; no watcher |

**Philosophy**: DSH hot-swaps *changes to already-assembled content*; it
does not hot-swap *assembly itself*. Hot-applying an assembly change (a
package pulling in 94 new dependencies) has far worse failure/rollback
economics than fail-loud startup auditing (`must be a top-level YAML array`
— named at boot). Allocating heat by operation frequency (high-frequency
config edits hot, low-frequency package installs cold) is engineering
judgment, not a betrayal of the ethos; "everything is a plugin" promises
pluggable capability boundaries, not hot assembly.

**Industry norm**: VS Code "reload window" after installing an extension,
browsers restart after extension install, Claude Code reopens sessions
after adding an MCP server — *installing new packages reloads everywhere*;
hot-swap is promised for starting/stopping *installed* content (which DSH
delivers fully via dynamic plugins).

## 4. Why project-level MCP is a plugin's job (not built-in)

1. **Trust boundary**: executable configuration must not live where
   "opening the directory" executes it (see §2).
2. **The official extension point IS plugins**: every capability is a
   plugin row — a "project-level MCP loader" plugin is the sanctioned
   approach and breaks no layering.
3. **Honest risk-taking**: the plugin author makes the trust statement on
   the user's behalf, so the privilege reduction, auditing and documentation
   must be done properly (the plugin's three alignment measures).

## 5. Known boundaries of this plugin

- **Bundle install needs one restart**: `dsh plugin add` mutates the bundle
  list (the cold layer) — DSH mechanism, not a plugin defect; local
  iteration can hot-install via a user patch row by package name (see README
  "Restart-free dev path").
- **Tools only**: MCP resources/prompts have no consuming surface.
- **No task-based execution**: plain calls only (same as official
  `dsh-mcp-client`).
- **Pooled connections share state**: sessions of one project share one
  connection; stateful servers see one shared state.

## 6. v3 connection supervisor (design record)

Connections die as a matter of course (sleep/wake, browser restarts,
manual process kills, server crashes) — and silent death is the worst
failure: tools stay listed, calls fail forever, no log anywhere. v3 turns
"silent death" into "auto-revive in seconds".

**Decisions**:

- **Event-driven (SDK `client.onclose`), not polling**: PoC-verified on
  Windows force-kill of the stdio child (child close → transport.onclose →
  protocol._onclose → client.onclose). Zero overhead, first-moment
  awareness.
- **No backoff retry loop**: a failed rebuild stops and waits for the next
  trigger (config change, new session, another death). Exponential backoff
  suits the official bridge (one instance, one connection); a project-level
  bridge must avoid multi-session rebuild storms — event-driven plus
  stop-on-failure is simpler and reliable.
- **Failed rebuilds do not pollute the pool**: connectServer deletes the
  pool entry on failure; the next trigger retries fresh, no bad connection
  is cached.

**Race lesson (fixed in 0.1.10)**: `poolPromises.has(key)` ≠ "my
connection is alive". After onclose drops the pool entry, the FIRST session
to finish reload rebuilds the connection and refills the pool under the
SAME poolKey; later sessions' reloads see the pool entry (same fingerprint,
same key) and skip — but their tool definitions still bind the dead client.
Symptom: **old sessions Not connected, new sessions fine**. Fix: onclose
marks every live session's record for the server as `dead`; the skip
condition requires `!record.dead`, forcing every session to teardown and
rebuild (reusing the restored pool connection, never duplicating it).

