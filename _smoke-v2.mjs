// V2 smoke tests: fingerprint stability + config parsing + module loads.
import { entryFingerprint, parseProjectConfig, serverEntries, publicToolName } from './index.mjs'

let failures = 0
function assert(cond, label) {
  if (cond) console.log('  ok  ' + label)
  else { failures++; console.log('  FAIL ' + label) }
}

console.log('module loads: OK')

console.log('entryFingerprint:')
const a = { serverName: 's', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' }, override: false, toolCallTimeoutMs: 60000, cwd: undefined, headers: {}, url: undefined }
const b = { ...a }
assert(entryFingerprint(a) === entryFingerprint(b), 'same entry -> same fingerprint')
const c = { ...a, toolCallTimeoutMs: 30000 }
assert(entryFingerprint(a) !== entryFingerprint(c), 'timeout change -> different fingerprint')
const d = { ...a, env: { A: '2' } }
assert(entryFingerprint(a) !== entryFingerprint(d), 'env value change -> different fingerprint')
const e = { ...a, override: true }
assert(entryFingerprint(a) !== entryFingerprint(e), 'override change -> different fingerprint')
const f = { ...a, args: ['-y', 'y'] }
assert(entryFingerprint(a) !== entryFingerprint(f), 'args change -> different fingerprint')
assert(entryFingerprint(a).includes('"A","1"'), 'fingerprint contains env value (in-memory only)')

console.log('parseProjectConfig:')
assert(parseProjectConfig('{"mcpServers":{"x":{"command":"c"}}}').x.command === 'c', 'parses')
try { parseProjectConfig('{"servers":{}}'); assert(false, 'missing mcpServers rejected') } catch { assert(true, 'missing mcpServers rejected') }

console.log('serverEntries + interpolation:')
process.env.V2_TEST_TOKEN = 'tok'
const warns = []
const entries = serverEntries({ 's1': { command: 'npx', env: { T: '${V2_TEST_TOKEN}' } }, 'bad!': { command: 'x' } }, 'C:/p', (m) => warns.push(m))
assert(entries.length === 1 && entries[0].env.T === 'tok', 'interpolation works')
assert(warns.length === 1, 'invalid entry warned')

console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
