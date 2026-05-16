# Photon Engine Sync Implementation Plan

## Goal

Photon Engine sync means the client-side Engine and the server-side Engine
exchange the same durable operation protocol. The server side is not just a
database adapter: Engine enters the application server, then server-side
business logic validates and accepts the operation before durable storage is
updated.

```txt
Web / Tauri / mobile client Engine
  - Web: Rust Engine through WASM
  - Tauri: Rust Engine through Tauri invoke
  - mobile/iPad: native Rust/Swift/Kotlin bridge or WASM where practical
  - local store: PGlite on Web/Tauri, platform local Engine store on mobile
  - pending operation log

        POST /api/engine/push
        POST /api/engine/pull

Edge server
  - terminates public client traffic close to the user
  - owns Photon Live / realtime WebSocket rooms where possible
  - forwards Engine push/pull to the cloud authority
  - may cache bootstrap metadata, but does not decide durable truth

Cloud server / Photon Engine authority
  - Rust Engine
  - server-side business logic: auth, permissions, schema validation, audit
  - durable store behind that logic: TiDB/MySQL in production, SQLite for local preview
  - accepted operation log
  - remote sequence cursor
```

Photon Live remains separate. Live owns realtime Yjs rooms, WebSocket transport,
presence, awareness, and fast collaborative feel. Live does not decide durable
truth.

For local experiments that simulate Client -> Edge -> Cloud Server -> DB, see
[`three-tier-local-sync-lab.md`](./three-tier-local-sync-lab.md).

## Current State

- Client operations are created locally and stored in PGlite.
- Web calls Photon Engine through WASM.
- Tauri calls Photon Engine through a Tauri command into the Rust crate.
- Mobile/iPad is a first-class target for the same Engine protocol. The runtime
  bridge can differ by platform, but operation format, push/pull endpoints, and
  cursor semantics must stay identical.
- Engine server exposes `POST /api/engine/push`.
- Engine server exposes `POST /api/engine/pull`.
- Production topology can route those endpoints through an edge server first,
  then to the cloud server that owns durable truth.
- Engine server can use TiDB/MySQL through
  `PHOTON_ENGINE_DATABASE_URL=mysql://...` or
  `PHOTON_ENGINE_DATABASE_URL=tidb://...`.
- Engine server must keep business rules between incoming Engine operations and
  durable storage. The storage adapter is an implementation detail, not the
  product boundary.
- Engine and Live can run as separate binaries:
  - `photon-engine-server`
  - `photon-live-server`
  - `photon-server` remains a combined local compatibility binary.
- `mock-tachyon-api` remains a local test/scenario server, not the production
  Engine role.

## Target Write Flow

1. User edits data in the client.
2. Client Engine creates an operation.
3. Client Engine applies the operation locally.
4. Client stores the projected record and pending operation in PGlite.
5. Sync loop sends pending operations to `POST /api/engine/push`.
6. Edge server authenticates/rate-limits/proxies the request when deployed.
7. Cloud server Engine parses the operation and routes it into application/domain logic.
8. Server-side business logic validates permissions, collection rules, schema,
   transitions, audit metadata, and conflict policy.
9. Cloud server stores accepted operations/projections with `remote_sequence`.
10. Server returns accepted/rejected/conflict decisions through the edge.
11. Client marks accepted operations in PGlite.
12. Client records rejected/conflict decisions for product-level resolution.

## Target Pull Flow

1. Client keeps a durable Engine cursor in PGlite.
2. Sync loop calls `POST /api/engine/pull` with the cursor, usually through the
   edge server.
3. Cloud server returns accepted operations after the cursor.
4. Client applies pulled operations through the local Engine runtime.
5. Client updates local projections in PGlite.
6. Client advances the cursor only after local apply succeeds.

## Runtime Call Map

Use this map when tracing a sync bug from UI to storage:

| Surface | Local Engine call | Local store | Server sync call |
| --- | --- | --- | --- |
| Web | `src/lib/photonEngine/client.ts` loads `packages/photon-engine/pkg/photon_engine.js` and applies operations through WASM | PGlite `appKitConfig.engine.pgliteDataDir` | `syncClientEngineOperations()` posts pending operations to `appKitConfig.engine.pushPath` |
| Tauri desktop | `src/lib/photonEngine/client.ts` calls Tauri `invoke('photon_engine_apply_operation')` | PGlite in the WebView | same `syncClientEngineOperations()` HTTP push path |
| Tauri mobile/iPad | planned Tauri invoke bridge mirroring desktop | PGlite or Rust/SQLite after durability decision | same push/pull JSON protocol |
| Edge server | Worker/edge runtime or lightweight Rust ingress receives public client traffic | cache/session/rate-limit only | proxies Engine push/pull to cloud authority; owns nearby Live transport when possible |
| Cloud Server Engine | `packages/server/src/lib.rs` receives `/api/engine/push` and `/api/engine/pull` behind edge | business/domain layer first, then `photon-engine` storage adapter backed by TiDB/MySQL in production | accepts/rejects/publishes remote sequence cursor |
| Live | `src/lib/yjs/*` and `/ws` realtime transport, often edge-hosted | Yjs IndexedDB / room state | no durable Engine decisions |

## Remaining Implementation Work

### 1. Client Pull Apply

- Add a client function that calls `appKitConfig.engine.pullPath`.
- Store Engine sync cursors in PGlite.
- Apply pulled operations through the same runtime branch:
  - Web: WASM
  - Tauri: Rust invoke
- Persist resulting projections into PGlite.
- Advance the cursor after successful local apply.

### 2. Client Sync Loop

- Add `syncClientEngine()` as the main public entrypoint.
- Run push first, then pull.
- Trigger sync on:
  - app boot after PGlite initialization
  - browser `online`
  - visibility return
  - successful Live reconnect
  - manual refresh/debug action
- Add backoff and avoid concurrent sync runs.

### 3. Mobile And iPad Client Runtime

- Treat iPhone/iPad as first-class Photon Engine clients, not companion views.
- Reuse the same operation JSON protocol used by Web and Tauri.
- Add a Tauri mobile command surface that mirrors the desktop invoke contract:
  - `photon_engine_apply_operation`
  - `photon_engine_sync_push`
  - `photon_engine_sync_pull`
- Decide the local store for mobile:
  - iPad/Tauri shell can keep PGlite if WebView IndexedDB durability is
    acceptable.
  - Native bridge can use SQLite through the Rust Engine crate if IndexedDB
    durability is insufficient.
- Add mobile-local operation queue persistence tests for app restart.
- Add simulator smoke for offline create -> restart -> push -> pull.
- Keep local durable storage on-device so edits survive app restarts and bad
  network conditions.
- Sync over the same Engine server endpoints:
  - `POST /api/engine/push`
  - `POST /api/engine/pull`
- Make iPad layout a primary product surface for workspace/table/document flows:
  - split view for sidebar + table/document
  - touch-friendly row selection and command actions
  - resilient offline banner/sync status
- Keep Photon Live optional: mobile should still sync durable Engine operations
  even if realtime rooms are disconnected.

### 4. Decision Handling

- Accepted: mark local operation `accepted`.
- Rejected: mark local operation `rejected` and keep the reason.
- Conflict: mark local operation `conflict` and store conflict payload.
- Server patch: apply server operation locally and persist projection.

### 5. Server Validation And Authorization

- Validate workspace scope before accepting operations.
- Check user/session permissions.
- Reject writes to collections the caller cannot mutate.
- Add audit metadata to accepted operations.
- Keep business validation outside Photon Live.

### 6. TiDB/MySQL Production Hardening

- Run `npm run server:engine:smoke` against a real TiDB endpoint.
- Confirm table DDL against TiDB SQL mode and MySQL compatibility mode.
- Add deployment docs for TLS and connection parameters.
- Add migration/version tracking for Engine tables.

### 7. Observability

- Log push/pull counts, accepted/rejected/conflict counts, and cursor movement.
- `GET /api/engine/debug` exposes Engine storage debug state for local and
  development verification.
- The `/sync` app dashboard shows client PGlite queue state, edge proxy logs,
  and cloud Engine accepted operations.
- Add product-facing client-side sync status:
  - idle
  - syncing
  - offline
  - conflict
  - error

## Non-Goals

- Do not put durable truth in Photon Live.
- Do not use WebSocket presence as proof of durable sync.
- Do not bypass the client Engine runtime when applying pulled operations.
- Do not make TiDB/MySQL a requirement for local development.

## Verification Checklist

- Web creates an operation offline and stores it in PGlite.
- Tauri creates an operation offline and stores it in PGlite.
- iPhone/iPad creates an operation offline and stores it durably on-device.
- Web pushes pending operations to Engine server.
- Tauri pushes pending operations to Engine server.
- iPhone/iPad pushes pending operations to Engine server.
- A second client pulls accepted operations and updates local PGlite projections.
- A mobile client pulls accepted operations and updates its local projection.
- Pull cursor survives reload.
- Pull cursor survives mobile app restart.
- Conflict/rejection decisions are visible and not dropped.
- Engine server works with SQLite locally.
- Engine server works with TiDB/MySQL in production smoke.
- Live server can be stopped without losing Engine sync correctness.
