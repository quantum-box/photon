/**
 * The TypeScript client (through the WASM kernel) and the Rust client must
 * turn the same intent into the same bytes. The Rust half of this contract is
 * `crates/photon-client/tests/operation_parity.rs`, asserting against the
 * same fixture.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPhotonKernel } from '@quantum-box/photon-wasm'

interface ParityFixture {
  actor_id: string
  now_ms: number
  intent: unknown
  expected_operation_json: string
}

describe('operation parity with the Rust client', () => {
  it('builds the fixture operation byte-for-byte', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(process.cwd(), '../../crates/photon-client/tests/fixtures/operation_parity.json'),
        'utf8',
      ),
    ) as ParityFixture

    const module = await loadPhotonKernel()
    const kernel = new module.PhotonKernel(fixture.actor_id, fixture.now_ms)
    const serialized = kernel.buildOperation(JSON.stringify(fixture.intent), fixture.now_ms)

    expect(serialized).toBe(fixture.expected_operation_json)
  })
})
