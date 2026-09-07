// Real WASM + filesystem PGlite + native HTTP protocol, using disposable data.
// Prerequisites: npm run engine:wasm && npm run build:packages
//               cargo build -p photon-server --bin photon-engine-server
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { createPhotonClient, createEngineTransport } from '../packages/core/dist/index.js'
import { createPGliteStore } from '../packages/store-pglite/dist/index.js'
import { loadPhotonKernel } from '../packages/wasm/dist/index.js'

const directory = await mkdtemp(join(tmpdir(), 'photon-scoped-smoke-'))
const socket = createServer()
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise(resolve => socket.close(resolve))
const baseUrl = `http://127.0.0.1:${port}`
const token = 'disposable-smoke-token'
const server = spawn(process.env.PHOTON_SMOKE_SERVER ?? './target/debug/photon-engine-server', [], {
  env: { ...process.env, PHOTON_ENGINE_PORT: String(port), PHOTON_AUTH_TOKENS: token,
    PHOTON_ENGINE_APP_DATABASE_URL: `sqlite:${join(directory, 'app.db')}?mode=rwc`,
    PHOTON_ENGINE_DATABASE_URL: `sqlite:${join(directory, 'engine.db')}?mode=rwc` },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = ''
server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-12000) })
server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-12000) })
let spawnError
server.on('error', error => { spawnError = error })
const clients = new Set()
try {
  for (let i = 0; ; i++) {
    if (spawnError) throw spawnError
    if (server.exitCode !== null) throw new Error(`server exited: ${logs}`)
    if (await fetch(`${baseUrl}/api/health`).then(r => r.ok).catch(() => false)) break
    if (i >= 120) throw new Error(`server startup timed out: ${logs}`)
    await delay(250)
  }
  const kernel = await loadPhotonKernel()
  let loseNextPush = false
  const requests = []
  const transport = createEngineTransport({ baseUrl, atomic: true, headers: () => ({ authorization: `Bearer ${token}` }),
    fetch: async (url, init) => {
      requests.push(String(url))
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`)
      if (loseNextPush && String(url).endsWith('/push')) {
        loseNextPush = false
        assert.equal(response.ok, true)
        await response.text()
        throw new Error('simulated lost acknowledgement after server commit')
      }
      return response
    },
  })
  async function open(name) {
    const client = await createPhotonClient({ scope: 'tenant:smoke:workspace:scoped-smoke', actorId: name, kernel, transport,
      storage: await createPGliteStore({ dataDir: join(directory, name) }),
      collections: { records: { mode: 'engine-native', hydration: 'on-demand' } }, cache: { maxRecords: 2 },
      sync: { mode: 'scoped', autoStart: false, pullPageSize: 1, selectionPageBudget: 1 },
    })
    clients.add(client)
    return client
  }
  async function close(client) { await client.close(); clients.delete(client) }
  async function complete(subscription) {
    for (let i = 0; i < 100; i++) {
      await subscription.refresh()
      if (subscription.getSnapshot().status === 'complete') return
    }
    throw new Error('selection failed to catch up within 100 pages')
  }
  async function rows(client) { return (await client.readPage({ collection: 'records', limit: 100 })).data }
  let writer = await open('writer')
  const batch = writer.transact(['a', 'b', 'c'].map(recordId => ({ collection: 'records', recordId,
    kind: { type: 'upsert', value: { region: recordId === 'b' ? 'west' : 'east', n: 10 } },
  })), { atomic: true })
  await batch.local
  await close(writer) // The complete atomic envelope must survive an offline restart.
  writer = await open('writer')
  assert.equal(writer.pendingCount(), 3)
  await writer.sync.syncNow()
  assert.equal(writer.pendingCount(), 0, JSON.stringify(writer.sync.getStatus()))

  let reader = await open('reader')
  const selector = { collection: 'records', filters: [{ field: 'region', op: 'eq', value: 'east' }] }
  let interest = reader.subscribeSync('east', selector)
  await interest.refresh()
  assert.equal(interest.getSnapshot().status, 'partial')
  await close(reader)
  reader = await open('reader')
  interest = reader.subscribeSync('east', selector)
  await complete(interest)
  assert.deepEqual((await rows(reader)).map(r => r.key.record_id), ['a', 'c'])

  await reader.increment('records', 'a', 'n', 1).local
  loseNextPush = true
  await reader.sync.syncNow()
  await complete(interest)
  assert.equal(reader.pendingCount(), 0)
  assert.equal((await rows(reader)).find(r => r.key.record_id === 'a').value.n, 11)
  await close(reader)
  reader = await open('reader')
  assert.equal((await rows(reader)).find(r => r.key.record_id === 'a').value.n, 11)
  interest = reader.subscribeSync('east', selector)

  await writer.readPage({ collection: 'records', recordIds: ['a', 'c'], limit: 2 })
  await writer.patch('records', 'a', { region: 'west' }).local
  await writer.remove('records', 'c').local
  await writer.sync.syncNow()
  await complete(interest)
  assert.deepEqual(await rows(reader), [])
  assert.equal(requests.some(url => url.endsWith('/pull')), false, 'scoped mode must never fetch the full log')
  assert.equal(requests.some(url => url.endsWith('/push-atomic')), true)
  console.log(JSON.stringify({ ok: true, checks: ['atomic offline restart', 'paged snapshot/cursor restart', 'predicate isolation', 'lost-ACK increment', 'durable reopen', 'out-of-scope eviction', 'remote deletion', 'no full pull'] }))
} finally {
  for (const client of clients) await client.close()
  server.kill('SIGTERM')
  if (server.exitCode === null && !spawnError) await new Promise(resolve => server.once('exit', resolve))
  await rm(directory, { recursive: true, force: true })
}
