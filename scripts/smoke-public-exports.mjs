/**
 * Prove the *published* surface works, not the workspace one.
 *
 * The playground imports the workspace names (`@quantum-box/photon-react`), so
 * nothing in this repository exercises `@quantum-box/photon/react` the way an
 * installing app does. That gap shipped a dist importing a package name which
 * only exists inside this workspace: every public entrypoint except the core
 * and `/rest` failed to resolve for consumers, and no gate noticed.
 *
 * So: pack the tarball, install it into a throwaway app with the peer
 * dependencies a real app has, and run the README's own wiring against it.
 *
 * Needs the toolchain `prepare` needs: a Rust toolchain and wasm-pack.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONSUMER_CHECK = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { createPhotonClient, buildWorkspaceScope, createEngineTransport } = await import('@quantum-box/photon')
const { createRestTransport } = await import('@quantum-box/photon/rest')
const { PhotonProvider, useLiveQuery, useMutation } = await import('@quantum-box/photon/react')
const { createPGliteStore } = await import('@quantum-box/photon/store-pglite')
const { loadPhotonKernel } = await import('@quantum-box/photon/wasm')

for (const [name, value] of Object.entries({
  createPhotonClient,
  buildWorkspaceScope,
  createEngineTransport,
  createRestTransport,
  PhotonProvider,
  useLiveQuery,
  useMutation,
  createPGliteStore,
  loadPhotonKernel,
})) {
  assert.equal(typeof value, 'function', name + ' is not exported as a function')
}

// The worker entry targets workerd and imports cloudflare: modules, so resolve
// it rather than evaluate it.
assert.ok(createRequire(import.meta.url).resolve('@quantum-box/photon/worker'))

// The README's wiring, end to end: kernel, durable store, one write read back.
const client = await createPhotonClient({
  scope: buildWorkspaceScope({ tenantId: 'smoke', workspaceId: 'smoke' }),
  actorId: 'smoke-device:smoke-user',
  storage: await createPGliteStore(),
  kernel: await loadPhotonKernel(),
})

const recordId = client.newId()
const handle = client.upsert('records', recordId, { title: 'packed' })
assert.equal(handle.optimistic?.value.title, 'packed', 'mutation was not applied synchronously')
await handle.local

const record = client.liveRecord('records', recordId).getSnapshot()
assert.equal(record.data?.value.title, 'packed', 'record did not read back from the store')
await client.close()

console.log('imported every entrypoint, loaded the kernel, wrote and read a record')
`

const CONSUMER_TYPES_CHECK = `
import { buildWorkspaceScope, createPhotonClient, type PhotonClient } from '@quantum-box/photon'
import { useLiveQuery } from '@quantum-box/photon/react'
import { createPGliteStore } from '@quantum-box/photon/store-pglite'
import { loadPhotonKernel } from '@quantum-box/photon/wasm'

export const useRecords = useLiveQuery

export async function wire(): Promise<PhotonClient> {
  return createPhotonClient({
    scope: buildWorkspaceScope({ tenantId: 'smoke', workspaceId: 'smoke' }),
    actorId: 'smoke-device:smoke-user',
    storage: await createPGliteStore(),
    kernel: await loadPhotonKernel(),
  })
}
`

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDir = mkdtempSync(join(tmpdir(), 'photon-exports-smoke-'))
const keep = process.env.PHOTON_SMOKE_KEEP === 'true'

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

try {
  // `npm pack` runs `prepare`, so this packs a freshly built tree.
  const packOutput = run('npm', ['pack', '--loglevel=warn', '--pack-destination', workDir], repoRoot)
  const tarball = join(workDir, packOutput.trim().split('\n').at(-1))

  writeFileSync(
    join(workDir, 'package.json'),
    JSON.stringify({ name: 'photon-exports-smoke', private: true, version: '0.0.0', type: 'module' }, null, 2),
  )
  writeFileSync(join(workDir, 'check.mjs'), CONSUMER_CHECK)
  writeFileSync(join(workDir, 'check.ts'), CONSUMER_TYPES_CHECK)

  // react is an optional peer dependency, so a consuming app brings its own.
  const peers = ['react@^19', '@types/react@^19']
  run('npm', ['install', tarball, ...peers, '--no-audit', '--no-fund', '--ignore-scripts'], workDir)
  process.stdout.write(run('node', ['check.mjs'], workDir))

  // The emitted .d.ts carried the same unresolvable specifier as the .js, so
  // type-check the entrypoints from outside the workspace too.
  run(
    'node',
    [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target', 'es2022',
      '--lib', 'es2022,dom',
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      'check.ts',
    ],
    workDir,
  )
  console.log('type-checked every entrypoint from a consuming app')
  console.log('public entrypoints: OK')
} finally {
  if (keep) console.log('kept smoke consumer at ' + workDir)
  else rmSync(workDir, { recursive: true, force: true })
}
