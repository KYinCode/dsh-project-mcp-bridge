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
//   both:   toolCallTimeoutMs? (default 60000), override? (default false),
//           idleTimeoutMs? (default 300000; 0 = never idle-disconnect)
//   env/headers values may reference ${NAME} -> process.env.NAME.
//
// v4 architecture — no connection pool; every agent owns its connections:
//   - Session creation (agent/created): read .dsh/mcp.json, register tool
//     schemas via a one-shot sync (connect + listTools + register + close).
//     No connection is kept: an idle session holds no child process.
//     Laziness applies to the CONNECTION, never to the REGISTRATION — the
//     model must see the tool list before it can call anything.
//   - First call to a server's tool: controller checks the per-server
//     connection; absent -> lazy connect ("connecting..." logged — that is
//     the first-call latency) -> call.
//   - Idle timeout (per-server idleTimeoutMs; default 5 min; 0 = never):
//     every call re-arms a per-connection timer; on fire the connection
//     closes and the child process is released; the next call reconnects.
//   - Unexpected death (client.onclose — verified on Windows force-kill):
//     THIS controller drops its dead connection; the next call reconnects.
//     No broadcast, no shared records, no races. N sessions calling one
//     server = N independent processes (isolation over sharing, by design).
//   - Disposal (agent/disposed): close all connections, clear timers,
//     unregister tools.
//   - Config hot-reload: watchFile still watches .dsh/mcp.json; a change
//     fully rebuilds this controller (no fingerprint diffing).
//   - Conflict semantics (unchanged): a serverName already provided by a
//     preset/host MCP row is SKIPPED by default; "override": true forces the
//     project connection (agent layer shadows upper layers).
//
// Trust model: .dsh/mcp.json is executable project content, same trust as
// package.json scripts. Children run with a scrubbed environment
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
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const WATCH_DEBOUNCE_MS = 300
// node timers wrap beyond 2^31-1 ms; clamp idle timeouts at the safe bound.
const MAX_TIMER_DELAY_MS = 0x7fffffff

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
    let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
    if (raw.idleTimeoutMs !== undefined) {
      if (Number.isFinite(raw.idleTimeoutMs) && raw.idleTimeoutMs >= 0) idleTimeoutMs = Math.floor(raw.idleTimeoutMs)
      else warn(`server ${serverName}: idleTimeoutMs must be a non-negative number — using default ${DEFAULT_IDLE_TIMEOUT_MS}ms`)
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
      idleTimeoutMs,
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// transport / client / definitions
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

/** Connect a fresh client and drain tools/list; closes it on failure. `onClose` fires on transport close (even during connect), `closed` reports whether it died before returning. */
async function connectAndList(ctx, entry, projectRoot, onClose) {
  const client = new Client({ name: 'dsh-project-mcp-bridge', version: '4.0.0' })
  const transport = createTransport(entry, projectRoot)
  let closed = false
  client.onclose = () => {
    closed = true
    if (onClose) onClose()
  }
  try {
    await client.connect(transport)
    const tools = []
    let cursor
    do {
      const page = await client.listTools({ cursor })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return { client, tools, closed }
  } catch (error) {
    try { await client.close() } catch { /* best effort */ }
    throw error
  }
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

/** callTool result -> model-facing content (isError results throw). */
function mapResult(result, rawName) {
  if (!Array.isArray(result.content)) {
    const rendered = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
    const text = typeof rendered === 'string' ? rendered : '(no output)'
    if (result.isError === true) throw new Error(text)
    return { content: [{ type: 'text', text }], ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
  }
  const text = extractText(result.content, rawName)
  if (result.isError === true) throw new Error(text)
  return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) }
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

/** One tool definition; raw MCP name travels on the wire. The execute preamble is the LAZY CONNECT: resolve the agent's current record, connect on first use, re-arm the idle timer around the call. */
function createDefinition(state, serverName, rawName, publicName, tool, entry) {
  return {
    name: publicName,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.inputSchema,
    output: createOutput(rawName),
    async execute(args, exec) {
      const record = state.servers.get(serverName)
      if (record === undefined) throw new Error(`server ${serverName} is no longer configured — reload the project config`)
      const conn = await ensureConnected(state, record)
      conn.busy++
      try {
        armIdle(state, record, conn)
        const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(record.entry.toolCallTimeoutMs)])
        const result = await conn.client.callTool(
          { name: rawName, arguments: typeof args === 'object' && args !== null ? args : {} },
          undefined,
          { signal },
        )
        return mapResult(result, rawName)
      } finally {
        conn.busy--
        armIdle(state, record, conn)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// per-agent controller: one connection set per agent, self-managed
// ---------------------------------------------------------------------------

/** One agent's live state: servers Map<serverName, record>; record = { entry, unregister, conn, connecting }; conn = { client, idleTimer, busy } or null when disconnected; connecting dedupes concurrent first calls; queue serializes config loads/reloads. */
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

// Live controllers by agent id; cleanup is driven by the host-level
// agent/disposed event (agentCtx.effect is unreliable on subagent contexts —
// its disposer runs immediately there, not on disposal).
const agentStates = new Map() // agentId -> controller

// per-project watchers: one fs.watchFile per project, fanned out to every
// live controller of that project. Watchers are config plumbing only — the
// connections themselves are never shared between agents.
const projectWatchers = new Map() // projectRoot -> { controllers: Set, timer }

function cleanupState(ctx, state, reason) {
  if (state.disposed) return
  state.disposed = true
  agentStates.delete(state.agent.id)
  for (const record of [...state.servers.values()]) {
    teardownServer(state, record, reason).catch(() => {})
  }
  detachWatcher(state)
  log(ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): cleanup (${reason})`)
}

// ---------------------------------------------------------------------------
// connections: lazy connect, idle timeout, dead detection
// ---------------------------------------------------------------------------

/** Arm the idle-disconnect timer on a live connection (0 = never). */
function armIdle(state, record, conn) {
  clearIdle(conn)
  if (conn.busy > 0) return // an in-flight call must never be cut off
  const timeout = record.entry.idleTimeoutMs
  if (timeout <= 0) return
  conn.idleTimer = setTimeout(() => {
    conn.idleTimer = null
    if (record.conn !== conn) return
    record.conn = null
    log(state.ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): server ${record.entry.serverName} idle for ${timeout}ms — disconnected (reconnects on next call)`)
    conn.client.close().catch(() => {})
  }, Math.min(timeout, MAX_TIMER_DELAY_MS))
  conn.idleTimer.unref?.()
}

function clearIdle(conn) {
  if (conn.idleTimer !== null) {
    clearTimeout(conn.idleTimer)
    conn.idleTimer = null
  }
}

/** Lazy connect for one server; concurrent callers share one in-flight attempt. */
async function openConnection(state, record) {
  const entry = record.entry
  const conn = { client: null, idleTimer: null, busy: 0 }
  log(state.ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): server ${entry.serverName}: connecting...`)
  const { client, closed } = await connectAndList(state.ctx, entry, state.projectRoot, () => {
    // Unexpected transport close: drop the dead connection, reconnect next call.
    if (record.conn === conn) {
      record.conn = null
      clearIdle(conn)
      log(state.ctx, 'warn', `agent ${state.agent.id} (${state.projectRoot}): server ${entry.serverName} connection closed unexpectedly — reconnecting on next call`)
    }
  })
  conn.client = client
  if (state.disposed || state.servers.get(entry.serverName) !== record) {
    try { await client.close() } catch { /* best effort */ }
    throw new Error(`server ${entry.serverName}: agent disposed or config reloaded during connect`)
  }
  record.conn = conn
  if (closed) {
    // Died during connect (or in the gap above, before conn was current — the
    // handler no-ops then); mark dead so the next call retries fresh.
    record.conn = null
    clearIdle(conn)
    try { await client.close() } catch { /* best effort */ }
    throw new Error(`server ${entry.serverName}: connection closed during connect`)
  }
  armIdle(state, record, conn)
  log(state.ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): server ${entry.serverName} connected`)
  return conn
}

/** Get the live connection for a record, connecting lazily when absent. */
function ensureConnected(state, record) {
  if (record.conn !== null) return Promise.resolve(record.conn)
  if (record.connecting === null) {
    const attempt = openConnection(state, record)
    record.connecting = attempt
    attempt.catch(() => {}).finally(() => {
      if (record.connecting === attempt) record.connecting = null
    })
  }
  return record.connecting
}

/** Close the live connection (intentional: idle, reload, disposal). */
async function disconnect(state, record, reason) {
  const conn = record.conn
  if (conn === null) return
  record.conn = null
  clearIdle(conn)
  try { await conn.client.close() } catch { /* best effort */ }
  log(state.ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): server ${record.entry.serverName}: ${reason}`)
}

// ---------------------------------------------------------------------------
// schema sync + registration
// ---------------------------------------------------------------------------

/** One-shot schema sync: connect, list tools, register definitions, close. Registration is eager (the model must see the tool list before it can call); the connection is the lazy part — released right after. */
async function syncSchema(state, entry) {
  const { client, tools } = await connectAndList(state.ctx, entry, state.projectRoot)
  try {
    const definitions = new Map()
    for (const tool of tools) {
      const publicName = publicToolName(entry.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(`server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      definitions.set(publicName, createDefinition(state, entry.serverName, tool.name, publicName, tool, entry))
    }
    const disposers = []
    for (const [publicName, definition] of definitions) {
      try {
        disposers.push(state.agentCtx.tools.register(definition))
      } catch (error) {
        log(state.ctx, 'error', `agent ${state.agent.id} (${state.projectRoot}): registering ${publicName} failed: ${String(error)}`)
      }
    }
    return {
      toolCount: disposers.length,
      unregister: () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* best effort */ }
        }
      },
    }
  } finally {
    try { await client.close() } catch { /* best effort */ }
  }
}

async function setupServer(state, entry) {
  const serverName = entry.serverName
  const upper = hasServerTools(state.agentCtx, serverName)
  if (!entry.override && upper) {
    log(state.ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): server ${serverName} already provided by preset/host MCP — skipped (set "override": true to force the project connection)`)
    return
  }
  try {
    const { toolCount, unregister } = await syncSchema(state, entry)
    if (state.disposed) {
      // Disposed (or reloaded away) while the schema sync was in flight:
      // discard the registrations, never leak tools or a record.
      unregister()
      return
    }
    state.servers.set(serverName, { entry, unregister, conn: null, connecting: null })
    // override:true with upper-layer registrations present = intentional
    // double connection. The agent-layer copy SHADOWS the upper layers for
    // same-named tools (layered registry), but the upper connections stay
    // alive — say so in the log, since the tool list shows no origin.
    const shadowed = upper ? ' (agent layer shadows upper-layer registration(s) for same-named tools; upper connections stay alive)' : ''
    log(state.ctx, 'info', `agent ${state.agent.id} (${state.projectRoot}): registered ${toolCount} tool(s) from server ${serverName}${shadowed}`)
  } catch (error) {
    log(state.ctx, 'error', `agent ${state.agent.id} (${state.projectRoot}): server ${serverName} not loaded: ${String(error)}`)
  }
}

async function teardownServer(state, record, reason) {
  state.servers.delete(record.entry.serverName)
  try { record.unregister() } catch { /* best effort */ }
  await disconnect(state, record, reason)
}

// ---------------------------------------------------------------------------
// config application (initial load + hot reload share one path)
// ---------------------------------------------------------------------------

/** Apply a (possibly new, possibly removed) config to one live agent: FULL rebuild — unregister everything, close everything, re-read, re-register (no fingerprint diffing). text === null means the config file is gone — everything unloads. */
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
  for (const record of [...state.servers.values()]) {
    await teardownServer(state, record, 'config change — rebuilding')
  }
  for (const entry of entries) {
    await setupServer(state, entry)
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
// watcher
// ---------------------------------------------------------------------------

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
    try {
      watchFile(configPath, { interval: 500 }, onChange)
    } catch (error) {
      log(state.ctx, 'warn', `watch ${configPath} failed: ${String(error)} — config hot-reload disabled for this project`)
    }
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
  // Plugin unload (HMR/dev reload): tear down every live controller so no
  // stale wiring keeps watching configs or holding connections after this
  // instance is gone (module-level state survives ctx disposal otherwise).
  ctx.effect(() => () => {
    for (const state of [...agentStates.values()]) {
      cleanupState(ctx, state, 'plugin reloaded')
    }
  })
  log(ctx, 'info', 'plugin active (v4) — per-agent connections, lazy connect, idle timeout')
}
