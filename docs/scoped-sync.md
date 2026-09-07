# Scoped sync, paged local reads and atomic writes

Photon owns synchronization and durable operation delivery. The host owns identity,
authorization rules, business validation and any side effects. These APIs do not
turn an ERP command or an external API call into a database transaction.

## Select the data a client needs

```ts
import { createPhotonClient, createEngineTransport } from '@quantum-box/photon'
import { createPGliteStore } from '@quantum-box/photon/store-pglite'
import { loadPhotonKernel } from '@quantum-box/photon/wasm'

const client = await createPhotonClient({
  scope: 'tenant:demo:workspace:demo',
  actorId: 'device-demo',
  kernel: await loadPhotonKernel(),
  storage: await createPGliteStore({ dataDir: 'idb://demo' }),
  transport: createEngineTransport({ baseUrl: '/sync', atomic: true }),
  collections: {
    records: { mode: 'engine-native', hydration: 'on-demand' },
  },
  cache: { maxRecords: 500 },
  sync: { mode: 'scoped', pullPageSize: 100, selectionPageBudget: 10 },
})

const selector = {
  collection: 'records',
  filters: [{ field: 'region', op: 'eq' as const, value: 'east' }],
}
const interest = client.subscribeSync('east-records', selector)
await interest.refresh()
const state = interest.getSnapshot()
// state.status: uninitialized | partial | complete
// state.updatedAtMs is the last successful local commit, not an online guarantee.
// state.error reports a failed refresh without discarding the cached state.
const stopWatching = interest.subscribe(() => render(interest.getSnapshot()))
```

`scoped` mode never invokes the legacy full-scope pull. Active subscriptions are
refreshed by the normal sync loop. `autoStart: false` allows manual `syncNow()` or
`interest.refresh()`. Each refresh processes at most `selectionPageBudget` pages;
call again, or let the next sync cycle continue, while status is `partial`.
`complete` means caught up at the last successful refresh, including a complete
empty result. It does not mean the client is currently online or the server has
stopped changing. A failed refresh leaves that last successful status and exposes
an error separately.

Selectors support a collection, an optional list of record IDs, and ANDed scalar
filters: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `exists`. Dotted field paths
address object properties. Comparisons are typed: a number does not equal a
string. A missing field differs from JSON null; `exists: true` includes null.
`ne` also includes missing fields. Range comparisons require numbers or strings
of the same type. ID lists are capped at 1000, filters at 32 and `in` lists at
1000. Empty ID/`in` lists match nothing. Pages use ascending record ID keysets,
not offsets. These are membership predicates, not sorted top-N subscriptions.
SQL adapters apply predicates before LIMIT; unindexed JSON predicates can still
require a database scan. This bounds page transfer and client hydration, not the
cost of every server query.

A subscription ID identifies a persisted selector and cursor. Reopen the same ID
with the same selector to resume offline state. For a changed selector, await
`release()` first or use a new ID. Snapshot keyset pages begin at a recorded
operation high-watermark, then replay changes from that watermark, so writes
before an already traversed key are not missed. Cursor, membership, checkpoint
and projected records commit together. Cursors are bound to scope and selector;
they are progress markers, not authorization credentials.

## Load and retain a bounded local working set

```ts
const page = await client.readPage({ ...selector, limit: 100 })
if (page.hasMore) {
  const next = await client.readPage({
    ...selector, limit: 100, afterId: page.nextAfterId!,
  })
}
const row = client.liveRecord('records', 'demo-record')
await row.ready()
// row is reactive. readPage() returns a one-time local page.
row.destroy()
client.evictRecords('records', ['demo-record'])
```

`readPage` queries the durable local store, not the network. Local pages can be
incomplete until the associated interest has caught up. `on-demand` collections
skip collection hydration at startup; `query()` and `hydrateCollection()` reject
for these collections. Use paged reads and `liveRecord` instead. Read an existing
on-demand record before applying partial mutations. An upsert may create a new
record without a read. Configure on-demand collections explicitly at creation;
dynamically resolved collections discovered after bootstrap cannot retroactively
prevent bootstrap hydration.

`cache.maxRecords` is a best-effort memory bound for on-demand records. Pending
edits and records held by active live queries are pinned and can exceed it.
`evictRecords` evicts memory only; a later read reloads the durable row.
`interest.close()` stops refreshing but preserves the offline cache.
`await interest.release()` removes its persisted cursor/membership and reclaims
records and checkpoints that no other interest retains. Operation history is
retained; release is not operation-log compaction. Do not reuse an ID before its
release completes. A client serializes its selection commits with local writes;
applications sharing one store should give each interest a single owner rather
than concurrently driving the same subscription ID in multiple clients.

## Scope exit, deletion and access loss

The pull protocol distinguishes `out_of_scope`, `deleted` and `revoked`.
Scope exit drops one membership; other interests retain the row. A pending edit
survives scope exit and restart, then the unretained cache is reclaimed after
any terminal decision (after conflict evidence is saved). Deletion/access loss removes the displayed projection and all
memberships and turns unaccepted edits into durable conflicts, stopping automatic
resend. Atomic siblings are quarantined together; choosing remote for an accessible sibling restores its accepted base without creating a new write. The conflict retains the local
value for recovery; this is not secure erasure of previously downloaded content.

`EnginePolicy.authorize_read` lets the host filter selected records. It defaults
to allow, matching the existing trusted-service deployment model. Authentication
and scope checks still run before selection. Selectors cannot grant permission.
Each pull also validates a rotating page of up to 200 already-held IDs, with its progress persisted across restart. Revocations only name IDs supplied by the caller, so broad subscriptions cannot enumerate unseen unauthorized records. Held-record access loss is eventually discovered without a record write; immediate revocation and newly granted access still require host invalidation or resetting the interest. Hosts needing cryptographic revocation must manage cache encryption and
keys outside this feature.

## Stable REST operation context

`RestResource` write callbacks receive an additional `RestOperationContext`:
`operationId`, `scope`, `actorId`, optional `expectedVersion`, and `signal`.
Existing callbacks accepting fewer arguments remain compatible.

```ts
const resource = {
  list: async () => fetchRecords(),
  update: async (id, patch, context) => {
    return updateRecord(id, patch, {
      idempotencyKey: context.operationId,
      expectedVersion: context.expectedVersion,
      signal: context.signal,
    })
  },
}
client.patch('records', 'demo-record', { title: 'Demo' }, {
  expectedVersion: 'version-7',
})
```

The operation ID and expected version persist in the offline log and remain
stable on retry/restart. The host chooses how to encode and enforce them, for
example as an idempotency key or an If-Match header. Photon does not invent
server-side idempotency or version checking for a legacy API. `MutationOptions`
is also supported by upsert, and `mutate()` accepts `expectedVersion` for other
mutation kinds.

REST-backed scoped sync requires the resource's optional `pullSelection` hook,
which returns the same checkpoint/removal/cursor contract. An ordinary `list()`
response is not treated as a complete partial-sync feed. Unsupported resources
fail explicitly. In particular, checkpoints must include a sequence and receipts
must identify already accepted pending operations so non-idempotent operations
are not replayed twice. Native requests send at most 1000 pending operations for
receipt lookup; drain a larger queue before scoped pulling (it fails explicitly,
without silently truncating receipts).

## Atomic operation batches

```ts
const mutation = client.transact([
  { collection: 'records', recordId: 'demo-a',
    kind: { type: 'upsert', value: { title: 'A' } } },
  { collection: 'records', recordId: 'demo-b',
    kind: { type: 'upsert', value: { title: 'B' } } },
], { atomic: true })
await mutation.local   // the entire local operation envelope is durable
await mutation.settled // the server decision
```

Atomic mode requires a single native transport with `supportsAtomic: true`;
`createEngineTransport({ atomic: true })` opts into the dedicated
`POST /api/engine/push-atomic` endpoint. At most 1000 operations are allowed.
Unsupported transports and mixed REST/native batches fail before optimistic
application. Batch ID and membership are persisted, so restart/retry preserves
the same envelope. Missing, duplicate or mixed server decisions fail the protocol
check and retain the batch for retry. A legacy endpoint cannot silently downgrade
an atomic request. Ordinary `transact()` retains its existing local grouping and
independent remote decisions.

The native endpoint authorizes and validates every member before accepting any.
Memory, SQLite and MySQL storage adapters commit the complete batch atomically;
a storage failure or rejected member leaves no accepted member. Duplicate replay
returns the original acceptance and never increments twice. This guarantees
atomic acceptance of the operation log and server projections. It does not make
side effects in policy callbacks transactional, implement business invariants,
or deliver all records atomically across separately paged subscriptions.
Custom Rust adapters must implement `append_authoritative_batch` to opt in.

## Compatibility and verification

The normal full-sync protocol, existing collection hydration and REST callback
arities remain supported. PGlite migration adds selection state, memberships,
checkpoints and deferred eviction tables; it does not rewrite existing records.
The shared-store RPC forwards these optional extensions. Custom stores need the
paged read and selection methods for scoped mode; old stores continue to support
full mode. Native selected reads use `POST /api/engine/selection`.

Run focused unit/adapter tests and the disposable real-stack smoke:

```sh
npm run engine:wasm
npm run build:packages
npm run test --workspace @quantum-box/photon-core -- --maxWorkers=1
npm run test --workspace @quantum-box/photon-store-pglite -- --maxWorkers=1
cargo test -j 2 -p photon-engine -p photon-axum
cargo build -j 2 -p photon-server --bin photon-engine-server
npm run smoke:scoped-sync
```

For the optional real-MySQL storage contract, set
`PHOTON_SCOPED_TEST_MYSQL_URL` to a disposable empty test database, then run
`cargo test -p photon-engine --test scoped_contract`. Never use a production
database for this test.
