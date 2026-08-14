// dsh-project-mcp-bridge: per-project MCP loading from <projectRoot>/.dsh/mcp.json.
//
// Host-plane plugin row (installed as a profile bundle — see package.json
// dsh.bundle.patch and cordis.patch.yml):
//   - id: dsh-project-mcp-bridge
//     name: 'dsh-project-mcp-bridge'
//
// Project config file — the mcpServers JSON shape shared by Claude Code,
// Cursor and VS Code, placed at the project root:
//   .dsh/mcp.json  ->  { "mcpServers": { "<serverName>": { ... } } }
//
// Server entry fields (same names as dsh-mcp-client):
//   stdio:  { command, args?, env?, cwd? }
//   http:   { url, headers? }
//   both:   toolCallTimeoutMs? (default 60000), override? (default false)
//   env/headers values may reference ${NAME} -> process.env.NAME.
//
// v2: CONFIG HOT-RELOAD. Each project's .dsh/mcp.json is watched; saving a
// change re-resolves the config for every LIVE agent of that project and
// performs a generation swap:
//   - added server    -> connect + register tools (live sessions gain them)
//   - removed server  -> unregister tools + release the pooled connection
//   - changed server  -> teardown the old generation, connect the new one
//                        (same serverName keeps the same tool names, so
//                        recorded tool calls stay replayable)
// A config that disappears unloads all project MCP tools for live agents.
// Tool names are stable per serverName, matching the official bridge's
// hot-replace semantics.
//
// Conflict semantics vs. preset/host MCP rows:
//   - Tools register into the AGENT scope layer, which shadows same-named
//     tools in the preset layer and the global layer (layered registry).
//   - By default a serverName already provided by a preset/host row is
//     SKIPPED (one live connection per server; log explains why). Set
//     "override": true on the entry to force the project connection
//     instead (double connection accepted, project tools win).
//
// Lifecycle: connections are pooled per (projectRoot, serverName, config
// fingerprint) and shared across agents of the same project; each agent
// registers its own tool copies and releases one reference on disposal or
// generation swap; the pool closes when the last reference leaves.
//
// Trust model: .dsh/mcp.json is executable project content, same trust as
// package.json scripts. Child processes run with a scrubbed environment
// (credential-shaped and stale DSH_* variables dropped), matching the
// official dsh-mcp-client bridge.
//
// Logs: ctx.logger plus ~/.dsh/logs/dsh-project-mcp-bridge/
// dsh-project-mcp-bridge.log (host stdout is not persisted by this deployment).

import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { watchFile, unwatchFile } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const name = 'dsh-project-mcp-bridge'
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
// Plugin-scoped log: logs/ root holds directories per plugin, not loose files.
const LOG_FILE = join(DSH_HOME, 'logs', 'dsh-project-mcp-bridge', 'dsh-project-mcp-bridge.log')
const DEFAULT_CALL_TIMEOUT_MS = 60000
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const WATCH_DEBOUNCE_MS = 300

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

let logFileReady = null
function fileLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
  if (logFileReady === null) {
    logFileReady = mkdir(dirname(LOG_FILE), { recursive: true })
      .then(() => appendFile(LOG_FILE, line))
      .catch(() => {})
  } else {
    logFileReady = logFileReady.then(() => appendFile(LOG_FILE, line)).catch(() => {})
  }
}

function log(ctx, level, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](`dsh-project-mcp-bridge: ${message}`)
  } catch { /* logger absence is not fatal */ }
  fileLog(level, message)
}

// ---------------------------------------------------------------------------
// pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** mcp__<serverName>__<rawName>, normalized per the DeepSeek name contract. */
export function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Replace ${NAME} with process.env.NAME; missing vars are left verbatim and warned. */
export function interpolateEnv(value, warn) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => {
    const v = process.env[key]
    if (v === undefined) {
      warn(`environment variable ${key} is not set (referenced in project MCP config)`)
      return match
    }
    return v
  })
}

/** Parse and shape-check the raw file text into the mcpServers object. */
export function parseProjectConfig(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`)
  }
  const servers = parsed && parsed.mcpServers
  if (servers === undefined || typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('missing "mcpServers" object')
  }
  return servers
}

/** Normalize one mcpServers map into ordered server entries (invalid ones skipped with warnings). */
export function serverEntries(servers, projectRoot, warn) {
  const entries = []
  for (const [serverName, raw] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
      warn(`invalid serverName ${JSON.stringify(serverName)} — skipped`)
      continue
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      warn(`server ${serverName}: config must be an object — skipped`)
      continue
    }
    const hasCommand = typeof raw.command === 'string' && raw.command.length > 0
    const hasUrl = typeof raw.url === 'string' && raw.url.length > 0
    if (hasCommand === hasUrl) {
      warn(`server ${serverName}: provide exactly one of "command" (stdio) or "url" (streamable-http) — skipped`)
      continue
    }
    const env = {}
    if (raw.env !== undefined) {
      if (typeof raw.env !== 'object' || raw.env === null || Array.isArray(raw.env)) {
        warn(`server ${serverName}: env must be an object — skipped`)
        continue
      }
      for (const [k, v] of Object.entries(raw.env)) env[k] = interpolateEnv(v, (m) => warn(`server ${serverName}: ${m}`))
    }
    const headers = {}
    if (raw.headers !== undefined) {
      if (typeof raw.headers !== 'object' || raw.headers === null || Array.isArray(raw.headers)) {
        warn(`server ${serverName}: headers must be an object — skipped`)
        continue
      }
      for (const [k, v] of Object.entries(raw.headers)) headers[k] = interpolateEnv(v, (m) => warn(`server ${serverName}: ${m}`))
    }
    entries.push({
      serverName,
      override: raw.override === true,
      transport: hasCommand ? 'stdio' : 'streamable-http',
      command: hasCommand ? raw.command : undefined,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      cwd: typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : undefined,
      env,
      url: hasUrl ? raw.url : undefined,
      headers,
      toolCallTimeoutMs: Number.isFinite(raw.toolCallTimeoutMs) ? raw.toolCallTimeoutMs : DEFAULT_CALL_TIMEOUT_MS,
    })
  }
  return entries
}

/**
 * Stable config fingerprint for one server entry: any change to the entry
 * (command, args, env value, timeout, override, ...) produces a different
 * fingerprint, so the pool key and the change detection both key on it.
 * Env values may contain secrets — the fingerprint lives in memory only.
 */
export function entryFingerprint(entry) {
  const { serverName, ...rest } = entry
  const keys = Object.keys(rest).sort()
  return JSON.stringify(keys.map((k) => [k, rest[k]]))
}

// ---------------------------------------------------------------------------
// transport / client / tool definitions
// ---------------------------------------------------------------------------

function createTransport(entry, projectRoot) {
  if (entry.transport === 'stdio') {
    const cwd = entry.cwd === undefined ? projectRoot : isAbsolute(entry.cwd) ? entry.cwd : join(projectRoot, entry.cwd)
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      // Privilege reduction, matching the official bridge: credential-shaped
      // and stale DSH_* variables are dropped from the inherited environment,
      // then the project config's explicit env is merged on top.
      env: { ...scrubbedParentEnv(), ...entry.env },
      cwd,
    })
  }
  return new StreamableHTTPClientTransport(new URL(entry.url), { headers: entry.headers })
}

/** MCP content blocks -> model-facing text (mirrors dsh-mcp-client). */
function extractText(mcpContent, toolName) {
  const parts = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    switch (value.type) {
      case 'text':
        parts.push(typeof value.text === 'string' ? value.text : '')
        break
      case 'image':
        parts.push(`[image: ${value.mimeType ?? 'unknown'}]`)
        break
      case 'audio':
        parts.push(`[audio: ${value.mimeType ?? 'unknown'}]`)
        break
      case 'resource':
        parts.push(`[resource: ${value.resource?.uri ?? 'unknown'}]`)
        break
      default:
        parts.push(`[unsupported content type: ${value.type ?? 'unknown'}]`)
    }
  }
  return parts.join('\n')
}

/** Build the canonical output declaration (structured content falls back to JsonValue). */
function createOutput(rawName) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: {},
      },
      required: ['content'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: extractText(value.content, rawName) }]
    },
  }
}

/** One tool definition; raw MCP name is what travels on the wire. */
function createDefinition(client, rawName, publicName, tool, entry) {
  return {
    name: publicName,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.inputSchema,
    output: createOutput(rawName),
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(entry.toolCallTimeoutMs)])
      const result = await client.callTool(
        { name: rawName, arguments: typeof args === 'object' && args !== null ? args : {} },
        undefined,
        { signal },
      )
      if (!Array.isArray(result.content)) {
        const rendered = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
        const text = typeof rendered === 'string' ? rendered : '(no output)'
        if (result.isError === true) throw new Error(text)
        return { content: [{ type: 'text', text }], ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
      }
      const text = extractText(result.content, rawName)
      if (result.isError === true) throw new Error(text)
      return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
    },
  }
}

// ---------------------------------------------------------------------------
// connection pool (shared per projectRoot+serverName+fingerprint)
// ---------------------------------------------------------------------------

const poolPromises = new Map() // key -> Promise<{ client, transport, definitions }>
const poolRefs = new Map() // key -> number of agents holding a reference

function poolKey(projectRoot, serverName, fingerprint) {
  return `${projectRoot}\0${serverName}\0${fingerprint}`
}

async function connectServer(ctx, entry, projectRoot) {
  const fingerprint = entryFingerprint(entry)
  const key = poolKey(projectRoot, entry.serverName, fingerprint)
  const existing = poolPromises.get(key)
  if (existing !== undefined) return existing
  const attempt = (async () => {
    const client = new Client({ name: 'dsh-project-mcp-bridge', version: '1.0.0' })
    const transport = createTransport(entry, projectRoot)
    try {
      await client.connect(transport)
      const tools = []
      let cursor
      do {
        const page = await client.listTools({ cursor })
        tools.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor)
      const definitions = new Map()
      for (const tool of tools) {
        const publicName = publicToolName(entry.serverName, tool.name)
        if (definitions.has(publicName)) {
          throw new Error(`server listed tool "${tool.name}" more than once — invalid tool list`)
        }
        definitions.set(publicName, createDefinition(client, tool.name, publicName, tool, entry))
      }
      // v3: live connection supervisor. The SDK fires client.onclose when the
      // stdio child dies (verified on Windows force-kill). Drop the dead pool
      // entry and re-resolve every live session of this project: reload sees
      // the config still present, the pool empty, and rebuilds the connection.
      client.onclose = () => {
        if (poolPromises.get(key) !== attempt) return // superseded by a newer generation
        poolPromises.delete(key)
        log(ctx, 'warn', `server ${entry.serverName} (${projectRoot}): connection closed — reconnecting`)
        for (const state of agentStates.values()) {
          if (!state.disposed && state.projectRoot === projectRoot) {
            enqueue(state, () => reloadFromDisk(state))
          }
        }
      }
      return { client, transport, definitions }
    } catch (error) {
      try { await client.close() } catch { /* best effort */ }
      throw error
    }
  })()
  poolPromises.set(key, attempt)
  try {
    await attempt
    return attempt
  } catch (error) {
    poolPromises.delete(key)
    log(ctx, 'error', `server ${entry.serverName} (${projectRoot}): connection or tool sync failed: ${String(error)}`)
    throw error
  }
}

async function releasePoolRef(ctx, projectRoot, serverName, fingerprint) {
  const key = poolKey(projectRoot, serverName, fingerprint)
  const refs = (poolRefs.get(key) ?? 0) - 1
  if (refs > 0) {
    poolRefs.set(key, refs)
    return
  }
  poolRefs.delete(key)
  const promise = poolPromises.get(key)
  poolPromises.delete(key)
  if (promise === undefined) return
  try {
    const { client } = await promise
    await client.close()
    log(ctx, 'info', `server ${serverName} (${projectRoot}): closed (last agent released)`)
  } catch (error) {
    log(ctx, 'warn', `server ${serverName} (${projectRoot}): close failed: ${String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// per-agent controller + per-project watcher
// ---------------------------------------------------------------------------

/**
 * One agent's live state for its project MCP generation:
 *   servers  Map<serverName, { fingerprint, poolKey, unregister() }>
 *   queue    serializes config loads / reloads for this agent
 *   disposed agent is gone; no further work
 */
function createController(ctx, agent, projectRoot) {
  return {
    ctx,
    agent,
    agentCtx: agent.ctx,
    projectRoot,
    servers: new Map(),
    queue: Promise.resolve(),
    disposed: false,
    watcherRef: null,
  }
}

function enqueue(state, fn) {
  state.queue = state.queue.then(fn).catch((error) => {
    if (!state.disposed) log(state.ctx, 'error', `agent ${state.agent.id}: ${String(error)}`)
  })
  return state.queue
}

// per-project watchers: one fs.watchFile per project, fanned out to every
// live controller of that project.
const projectWatchers = new Map() // projectRoot -> { controllers: Set, timer, armed }

// Live controllers by agent id; cleanup is driven by the host-level
// agent/disposed event (agentCtx.effect is unreliable on subagent contexts —
// its disposer runs immediately there, not on disposal).
const agentStates = new Map() // agentId -> controller

function cleanupState(ctx, state, reason) {
  if (state.disposed) return
  state.disposed = true
  agentStates.delete(state.agent.id)
  for (const [serverName, record] of [...state.servers]) {
    teardownServer(ctx, state, serverName, record).catch(() => {})
  }
  detachWatcher(state)
  log(ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): cleanup (${reason})`)
}

function attachWatcher(state) {
  const root = state.projectRoot
  let w = projectWatchers.get(root)
  if (w === undefined) {
    w = { controllers: new Set(), timer: null }
    projectWatchers.set(root, w)
    const configPath = join(root, '.dsh', 'mcp.json')
    const onChange = () => {
      if (w.timer !== null) clearTimeout(w.timer)
      w.timer = setTimeout(() => {
        w.timer = null
        for (const controller of [...w.controllers]) {
          if (!controller.disposed) enqueue(controller, () => reloadFromDisk(controller))
        }
      }, WATCH_DEBOUNCE_MS)
    }
    w.armed = () => {
      try {
        watchFile(configPath, { interval: 500 }, onChange)
      } catch (error) {
        log(state.ctx, 'warn', `watch ${configPath} failed: ${String(error)} — config hot-reload disabled for this project`)
      }
    }
    w.armed()
  }
  w.controllers.add(state)
  state.watcherRef = w
}

function detachWatcher(state) {
  const w = state.watcherRef
  if (w === undefined) return
  state.watcherRef = undefined
  w.controllers.delete(state)
  if (w.controllers.size === 0) {
    if (w.timer !== null) clearTimeout(w.timer)
    try { unwatchFile(join(state.projectRoot, '.dsh', 'mcp.json')) } catch { /* best effort */ }
    projectWatchers.delete(state.projectRoot)
  }
}

// ---------------------------------------------------------------------------
// config application (initial load + hot reload share one path)
// ---------------------------------------------------------------------------

async function teardownServer(ctx, state, serverName, record) {
  try { record.unregister() } catch { /* best effort */ }
  state.servers.delete(serverName)
  releasePoolRef(ctx, state.projectRoot, serverName, record.fingerprint).catch(() => {})
  log(ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): unregistered server ${serverName}`)
}

async function setupServer(ctx, state, entry) {
  const serverName = entry.serverName
  const upper = hasServerTools(state.agentCtx, serverName)
  if (!entry.override && upper) {
    log(ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): server ${serverName} already provided by preset/host MCP — skipped (set "override": true to force the project connection)`)
    return
  }
  try {
    const promise = await connectServer(ctx, entry, state.projectRoot)
    const { definitions } = await promise
    const fingerprint = entryFingerprint(entry)
    const key = poolKey(state.projectRoot, serverName, fingerprint)
    poolRefs.set(key, (poolRefs.get(key) ?? 0) + 1)
    const disposers = []
    for (const [publicName, definition] of definitions) {
      try {
        disposers.push(state.agentCtx.tools.register(definition))
      } catch (error) {
        log(ctx, 'error', `agent ${state.agent.id} (${state.projectRoot}): registering ${publicName} failed: ${String(error)}`)
      }
    }
    state.servers.set(serverName, {
      fingerprint,
      poolKey: key,
      unregister: () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* best effort */ }
        }
      },
    })
    // override:true with upper-layer registrations present = intentional
    // double connection. The agent-layer copy SHADOWS the upper layers for
    // same-named tools (layered registry), but the upper connections stay
    // alive — say so in the log, since the tool list shows no origin.
    const shadowed = upper ? ' (agent layer shadows upper-layer registration(s) for same-named tools; upper connections stay alive)' : ''
    log(ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): registered ${disposers.length} tool(s) from server ${serverName}${shadowed}`)
  } catch (error) {
    log(ctx, 'error', `agent ${state.agent.id} (${state.projectRoot}): server ${serverName} not loaded: ${String(error)}`)
  }
}

/**
 * Apply a (possibly new, possibly removed) config to one live agent:
 * generation diff against the agent's current generation. text === null
 * means the config file is gone — everything unloads.
 */
async function applyConfig(state, text) {
  if (state.disposed) return
  const ctx = state.ctx
  const entries = []
  if (text !== null) {
    let servers
    try {
      servers = parseProjectConfig(text)
    } catch (error) {
      log(ctx, 'error', `agent ${state.agent.id} (${state.projectRoot}): .dsh/mcp.json: ${error.message} — keeping current generation`)
      return
    }
    entries.push(...serverEntries(servers, state.projectRoot, (m) => log(ctx, 'warn', `agent ${state.agent.id} (${state.projectRoot}): .dsh/mcp.json: ${m}`)))
  }
  const next = new Map(entries.map((e) => [e.serverName, e]))
  const prev = state.servers

  // Removed servers first (so changed ones re-run the dedup check cleanly).
  for (const [serverName, record] of prev) {
    if (!next.has(serverName)) await teardownServer(ctx, state, serverName, record)
  }
  // Added and changed servers. A changed entry has a different fingerprint;
  // teardown the old generation, then set up the new one — same serverName
  // keeps the same public tool names, so recorded calls stay replayable.
  // An unchanged fingerprint is skipped UNLESS the pooled connection died
  // (the supervisor's onclose dropped the pool entry) — then rebuild.
  for (const [serverName, entry] of next) {
    const record = prev.get(serverName)
    if (record !== undefined && record.fingerprint === entryFingerprint(entry) && poolPromises.has(record.poolKey)) continue
    if (record !== undefined) await teardownServer(ctx, state, serverName, record)
    await setupServer(ctx, state, entry)
  }
}

async function reloadFromDisk(state) {
  if (state.disposed) return
  const configPath = join(state.projectRoot, '.dsh', 'mcp.json')
  let text = null
  try {
    text = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      log(state.ctx, 'warn', `agent ${state.agent.id} (${state.projectRoot}): cannot read ${configPath}: ${String(error)}`)
      return
    }
    // ENOENT: config removed — text stays null, everything unloads.
  }
  try {
    await applyConfig(state, text)
  } catch (error) {
    log(state.ctx, 'error', `agent ${state.agent.id} (${state.projectRoot}): reload failed: ${String(error)}`)
  }
}

function hasServerTools(agentCtx, serverName) {
  try {
    const schemas = agentCtx.tools.schemas()
    return Array.isArray(schemas) && schemas.some((s) => typeof s.name === 'string' && s.name.startsWith(`mcp__${serverName}__`))
  } catch {
    return false
  }
}

function agentCwd(agent) {
  return (agent && agent.session && agent.session.header && agent.session.header.cwd) ||
    (agent && agent.header && agent.header.cwd) ||
    undefined
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function wireAgent(ctx, agent) {
  const cwd = agentCwd(agent)
  if (!cwd) {
    log(ctx, 'warn', `agent ${agent.id}: no session cwd found — project MCP skipped`)
    return
  }
  const agentCtx = agent.ctx
  if (!agentCtx || typeof agentCtx.tools?.register !== 'function' || typeof agentCtx.tools?.schemas !== 'function') {
    log(ctx, 'warn', `agent ${agent.id} (${cwd}): agent tools service unavailable — project MCP skipped`)
    return
  }
  const state = createController(ctx, agent, cwd)
  agentStates.set(agent.id, state)
  attachWatcher(state)
  enqueue(state, () => reloadFromDisk(state))
}

export function apply(ctx) {
  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    try {
      wireAgent(ctx, agent)
    } catch (error) {
      log(ctx, 'error', `agent ${agent.id}: unexpected failure: ${String(error)}`)
    }
  })
  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    const state = agentStates.get(agent.id)
    if (state !== undefined) cleanupState(ctx, state, 'agent disposed')
  })
  log(ctx, 'info', 'plugin active (v2) — project MCP with config hot-reload')
}
