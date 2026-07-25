/**
 * The host-side contract for the WASM semantic kernel.
 *
 * The kernel is synchronous and holds no storage. Everything it needs from the
 * clock is passed in, which is what lets the client inject a deterministic
 * clock in tests.
 *
 * There is deliberately no JavaScript fallback. A previous implementation fell
 * back to a shallow object merge when the WASM module failed to load, which is
 * not CRDT semantics — it silently produced different, wrong merges depending
 * on whether a network fetch succeeded. Failing to load the kernel is now a
 * hard error.
 */

import type { EngineRecord, HybridTimestamp, Operation, OperationKind, RecordKey } from './types.js'

export interface OperationIntent {
  readonly key: RecordKey
  readonly kind: OperationKind
  readonly operation_id?: string
  readonly metadata?: unknown
}

export interface RemoteBatchInput {
  readonly operations: readonly Operation[]
  readonly records: readonly EngineRecord[]
  readonly applied_operation_ids: readonly string[]
  readonly now_ms: number
}

export interface RemoteBatchOutput {
  readonly records: EngineRecord[]
  readonly applied_operation_ids: string[]
  readonly skipped_operation_ids: string[]
}

/** The narrow surface `packages/core` uses. Mirrors `PhotonKernel` in Rust. */
export interface PhotonKernel {
  actorId(): string
  buildOperation(intentJson: string, nowMs: number): string
  applyOperation(currentJson: string | null | undefined, operationJson: string): string
  replay(currentJson: string | null | undefined, operationsJson: string): string
  applyRemoteBatch(batchJson: string): string
  observeTimestamp(timestampJson: string, nowMs: number): void
  currentTimestamp(): string
}

/**
 * What a caller passes as `kernel.module`: the object `wasm-pack` produces for
 * `crates/photon-engine`, already initialized.
 */
export interface PhotonKernelModule {
  PhotonKernel: new (actorId: string, nowMs: number) => PhotonKernel
}

export class KernelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      'Photon Engine WASM kernel failed to load. The engine cannot fall back to a ' +
        'JavaScript merge without changing merge semantics, so this is fatal. ' +
        'Run `npm run engine:wasm` and check that the .wasm asset is served.',
      { cause },
    )
    this.name = 'KernelUnavailableError'
  }
}

/** A typed, ergonomic wrapper over the raw JSON-in/JSON-out kernel. */
export class Kernel {
  constructor(
    private readonly inner: PhotonKernel,
    private readonly clock: () => number,
  ) {}

  get actorId(): string {
    return this.inner.actorId()
  }

  buildOperation(intent: OperationIntent): Operation {
    return JSON.parse(this.inner.buildOperation(JSON.stringify(intent), this.clock())) as Operation
  }

  applyOperation(current: EngineRecord | null, operation: Operation): EngineRecord {
    const json = this.inner.applyOperation(
      current ? JSON.stringify(current) : null,
      JSON.stringify(operation),
    )
    return JSON.parse(json) as EngineRecord
  }

  /**
   * Fold operations onto a record.
   *
   * Rollback uses this: re-project from the accepted operations only, rather
   * than restoring a remembered previous value that would erase whatever
   * remote edit arrived in the meantime.
   */
  replay(current: EngineRecord | null, operations: readonly Operation[]): EngineRecord | null {
    const json = this.inner.replay(
      current ? JSON.stringify(current) : null,
      JSON.stringify(operations),
    )
    return (JSON.parse(json) as { record: EngineRecord | null }).record
  }

  applyRemoteBatch(input: Omit<RemoteBatchInput, 'now_ms'>): RemoteBatchOutput {
    const json = this.inner.applyRemoteBatch(
      JSON.stringify({ ...input, now_ms: this.clock() }),
    )
    return JSON.parse(json) as RemoteBatchOutput
  }

  observeTimestamp(timestamp: HybridTimestamp): void {
    this.inner.observeTimestamp(JSON.stringify(timestamp), this.clock())
  }

  currentTimestamp(): HybridTimestamp {
    return JSON.parse(this.inner.currentTimestamp()) as HybridTimestamp
  }
}
