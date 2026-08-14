// v4 scripted integration test: drives the REAL plugin code paths
// (apply → wiring → schema sync → lazy connect → idle timeout → dead
// detection → hot reload → skip/override) against a real test-server child
// process, with fake Cordis/agent contexts. The plugin's module-level state
// is per-process, so this runs fully isolated from the live harness.
//
// Requires examples/test-server.mjs to append its PID to TEST_SERVER_PIDFILE
// (set per-server in the test config below).
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.DSH_HOME = join(process.cwd(), '.tmp-it', 'dsh-home')
const TMP = join(process.cwd(), '.tmp-it')
const PROJECT = join(TMP, 'project')
const CONFIG = join(PROJECT, '.dsh', 'mcp.json')
const PIDFILE = join(TMP, 'pids.txt')
const REPO = process.cwd()
const SERVER = { command: 'node', args: ['examples/test-server.mjs'], cwd: REPO, env: { TEST_SERVER_PIDFILE: PIDFILE }, idleTimeoutMs: 4000 }

let failures = 0
function assert(cond, label) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('  FAIL ' + label) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function writeConfig(extra) {
  await writeFile(CONFIG, JSON.stringify({ mcpServers: { ...extra } }, null, 2))
}

/** Count live test-server instances (pids recorded by the servers themselves). */
function liveServers() {
  let alive = 0
  try {
    for (const line of readFileSyncSafe(PIDFILE)) {
      const pid = Number(line.split(',')[0])
      try { process.kill(pid, 0); alive++ } catch { /* gone */ }
    }
  } catch { /* no pidfile yet */ }
  return alive
}
function readFileSyncSafe(p) {
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
}

// ---------------------------------------------------------------------------
// fake harness: ctx + agent + tools registry
// ---------------------------------------------------------------------------

function makeContext() {
  const handlers = {}
  const disposers = []
  const ctx = {
    logger: { info: (m) => console.log('[i]', m), warn: (m) => console.log('[w]', m), error: (m) => console.log('[e]', m) },
    on(name, cb) { handlers[name] = cb; return () => {} },
    effect(fn) { disposers.push(fn()); return () => {} },
  }
  return { ctx, handlers, disposers }
}

function makeAgent(id, upperSchemas) {
  const registry = new Map()
  const agentCtx = {
    tools: {
      register(definition) { registry.set(definition.name, definition); return () => registry.delete(definition.name) },
      schemas() { return upperSchemas },
    },
  }
  return { agent: { id, session: { header: { cwd: PROJECT } }, ctx: agentCtx }, registry }
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await sleep(150)
  }
  assert(false, `timeout waiting: ${label}`)
  return false
}

const call = async (registry, tool, args) => {
  const def = registry.get(tool)
  assert(def !== undefined, `tool ${tool} registered`)
  if (!def) throw new Error('missing tool')
  return def.execute(args ?? {}, { signal: new AbortController().signal })
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

await rm(TMP, { recursive: true, force: true })
await mkdir(join(PROJECT, '.dsh'), { recursive: true })
await writeConfig({ test: SERVER })

const plugin = await import(`./index.mjs?it=${Date.now()}`)
const { ctx, handlers, disposers } = makeContext()
plugin.apply(ctx)

const a1 = makeAgent('it-agent-1', [])
handlers['agent/created']({ agent: a1.agent })
console.log('--- test 1: lazy connect ---')
await waitFor(() => a1.registry.has('mcp__test__echo'), 15000, 'agent 1 tool registration')
assert(liveServers() === 0, `session creation leaves no process (live=${liveServers()})`)

console.log('--- test 2: first call connects lazily, idle timeout disconnects ---')
const r1 = await call(a1.registry, 'mcp__test__echo', { text: 'hello' })
assert(r1.content[0].text === 'hello', 'call returns server result')
assert(liveServers() === 1, `lazy connect spawned one process (live=${liveServers()})`)
await sleep(5500)
assert(liveServers() === 0, `idle timeout released the process (live=${liveServers()})`)

console.log('--- test 3: call after idle reconnects ---')
const r2 = await call(a1.registry, 'mcp__test__echo', { text: 'again' })
assert(r2.content[0].text === 'again', 'reconnect call succeeds')
assert(liveServers() === 1, `reconnect spawned one process (live=${liveServers()})`)
await sleep(5500)
assert(liveServers() === 0, `idle timeout released again (live=${liveServers()})`)

console.log('--- test 4: concurrent first calls share one connection ---')
const [c1, c2] = await Promise.all([
  call(a1.registry, 'mcp__test__add', { a: 1, b: 2 }),
  call(a1.registry, 'mcp__test__sleep', { ms: 3000 }),
])
assert(c1.content[0].text === '3' && c2.content[0].text === 'slept', 'parallel calls both succeed')
assert(liveServers() === 1, `parallel calls shared one connection (live=${liveServers()})`)

console.log('--- test 5: per-agent isolation (two agents, two processes) ---')
const a2 = makeAgent('it-agent-2', [])
handlers['agent/created']({ agent: a2.agent })
await waitFor(() => a2.registry.has('mcp__test__echo'), 15000, 'agent 2 tool registration')
assert(liveServers() === 1, `agent 2 creation adds no connection (live=${liveServers()})`)
await call(a2.registry, 'mcp__test__sleep', { ms: 3000 })
assert(liveServers() === 2, `both agents hold their own connection (live=${liveServers()})`)
await sleep(5500)
assert(liveServers() === 0, `both released on idle (live=${liveServers()})`)

console.log('--- test 6: killed process -> next call reconnects ---')
const r3 = await call(a1.registry, 'mcp__test__echo', { text: 'pre-kill' })
assert(r3.content[0].text === 'pre-kill', 'call before kill succeeds')
assert(liveServers() === 1, `one process before kill (live=${liveServers()})`)
// kill every live test-server process (both agents are idle-connected)
for (const line of readFileSyncSafe(PIDFILE)) {
  const pid = Number(line.split(',')[0])
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}
await sleep(800) // let onclose fire
const r4 = await call(a1.registry, 'mcp__test__echo', { text: 'post-kill' })
assert(r4.content[0].text === 'post-kill', 'call after kill reconnects automatically')
assert(liveServers() === 1, `one re-established connection (live=${liveServers()})`)

console.log('--- test 7: hot reload (config change -> full rebuild) ---')
await writeConfig({ test: SERVER, t2: { ...SERVER, env: { TEST_SERVER_PIDFILE: PIDFILE } } })
await waitFor(() => a1.registry.has('mcp__t2__echo'), 15000, 'added server t2 registered after reload')
assert(!a1.registry.has('mcp__gone__echo'), 'no phantom tools')
const r5 = await call(a1.registry, 'mcp__t2__echo', { text: 't2' })
assert(r5.content[0].text === 't2', 't2 server callable after reload')

console.log('--- test 7b: config emptied / deleted -> everything unloads ---')
await writeConfig({})
await waitFor(() => !a1.registry.has('mcp__test__echo') && !a1.registry.has('mcp__t2__echo'), 15000, 'empty config unloads all tools')
assert(liveServers() === 0, `no processes after config emptied (live=${liveServers()})`)
await writeConfig({ test: SERVER })
await waitFor(() => a1.registry.has('mcp__test__echo'), 15000, 'server re-added after empty config')
await rm(CONFIG, { force: true })
await waitFor(() => !a1.registry.has('mcp__test__echo'), 15000, 'config file deleted unloads all tools')
assert(liveServers() === 0, `no processes after config deleted (live=${liveServers()})`)

console.log('--- test 8: skip / override against upper-layer schemas ---')
const a3 = makeAgent('it-agent-3', [{ name: 'mcp__t2__echo' }])
handlers['agent/created']({ agent: a3.agent })
await sleep(2500)
assert(!a3.registry.has('mcp__t2__echo'), `upper-layer server skipped (has=${[...a3.registry.keys()].join(',') || 'none'})`)
const a4 = makeAgent('it-agent-4', [{ name: 'mcp__t2__echo' }])
handlers['agent/created']({ agent: a4.agent })
await sleep(2500)
assert(!a4.registry.has('mcp__t2__echo'), `upper-layer server skipped for agent 4 (has=${[...a4.registry.keys()].join(',') || 'none'})`)
await writeConfig({ test: SERVER, t2: { ...SERVER, override: true, env: { TEST_SERVER_PIDFILE: PIDFILE } } })
await waitFor(() => a3.registry.has('mcp__t2__echo'), 15000, 'override forces registration')
assert(a3.registry.has('mcp__t2__echo'), 'override registers project copy')

console.log('--- test 9: plugin dispose cleans everything ---')
for (const d of disposers) d()
await sleep(800)
assert(liveServers() === 0, `dispose released all processes (live=${liveServers()})`)
const leftovers = [...a1.registry.keys(), ...a2.registry.keys(), ...a3.registry.keys(), ...a4.registry.keys()]
assert(leftovers.length === 0, `dispose unregistered all tools (leftover: ${leftovers.join(',') || 'none'})`)

await rm(TMP, { recursive: true, force: true })
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
