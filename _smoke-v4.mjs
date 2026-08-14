// v4 smoke tests: config parsing + name normalization + module loads.
import { parseProjectConfig, serverEntries, publicToolName, interpolateEnv } from './index.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('  FAIL ' + label) }
}

console.log('module loads: OK')

console.log('parseProjectConfig:')
assert(parseProjectConfig('{"mcpServers":{"x":{"command":"c"}}}').x.command === 'c', 'parses')
try { parseProjectConfig('{"servers":{}}'); assert(false, 'missing mcpServers rejected') } catch { assert(true, 'missing mcpServers rejected') }

console.log('serverEntries + idleTimeoutMs:')
const warns = []
const entries = serverEntries({
  's1': { command: 'npx' },
  's2': { command: 'npx', idleTimeoutMs: 0 },
  's3': { command: 'npx', idleTimeoutMs: 5000 },
  's4': { command: 'npx', idleTimeoutMs: -1 },
  's5': { command: 'npx', idleTimeoutMs: 'soon' },
}, 'C:/p', (m) => warns.push(m))
assert(entries.length === 5, 'all five entries kept (lenient idleTimeoutMs)')
assert(entries[0].idleTimeoutMs === 300000, 'default idleTimeoutMs = 5 min')
assert(entries[1].idleTimeoutMs === 0, 'idleTimeoutMs 0 = never disconnect')
assert(entries[2].idleTimeoutMs === 5000, 'explicit idleTimeoutMs kept')
assert(entries[3].idleTimeoutMs === 300000, 'negative idleTimeoutMs -> default + warn')
assert(entries[4].idleTimeoutMs === 300000, 'string idleTimeoutMs -> default + warn')
assert(warns.length === 2, `invalid idleTimeoutMs warned twice (got ${warns.length})`)

console.log('serverEntries + interpolation + validation:')
process.env.V2_TEST_TOKEN = 'tok'
const warns2 = []
const entries2 = serverEntries({ 's1': { command: 'npx', env: { T: '${V2_TEST_TOKEN}' } }, 'bad!': { command: 'x' } }, 'C:/p', (m) => warns2.push(m))
assert(entries2.length === 1 && entries2[0].env.T === 'tok', 'interpolation works')
assert(warns2.length === 1, 'invalid entry warned')

console.log('publicToolName:')
assert(publicToolName('git', 'create_issue') === 'mcp__git__create_issue', 'clean name verbatim')
const weird = publicToolName('git hub', 'a b')
assert(weird.startsWith('mcp__git_hub__a_b_') && weird.length <= 64, 'lossy name gets hash suffix, <= 64 chars')

console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
