# Photon Engine Sync Implementation Plan

## Goal

Photon Engine sync means the client-side Engine and the server-side Engine
communicate directly.

```txt
Web / Tauri / mobile client Engine
  - Web: Rust Engine through WASM
  - Tauri: Rust Engine through Tauri invoke
  - mobile/iPad: native Rust/Swift/Kotlin bridge or WASM where practical
  - local store: PGlite on Web/Tauri, platform local Engine store on mobile
  - pending operation log

        POST /api/engine/push
        POST /api/engine/pull

Photon Engine server
  - Rust Engine
  - durable store: TiDB/MySQL in production, SQLite for local preview
  - accepted operation log
  - remote sequence cursor
```

Photon Live remains separate. Live owns realtime Yjs rooms, WebSocket transport,
presence, awareness, and fast collaborative feel. Live does not decide durable
truth.

## Current State

- Client operations are created locally and stored in PGlite.
- Web calls Photon Engine through WASM.
- Tauri calls Photon Engine through a Tauri command into the Rust crate.
- Mobile/iPad is a first-class target for the same Engine protocol. The runtime
  bridge can differ by platform, but operation format, push/pull endpoints, and
  cursor semantics must stay identical.
- Engine server exposes `POST /api/engine/push`.
- Engine server exposes `POST /api/engine/pull`.
- Engine server can use TiDB/MySQL through `PHOTON_ENGINE_DATABASE_URL=mysql://...`.
- Engine and Live can run as separate binaries:
  - `photon-engine-server`
  - `photon-live-server`
  - `photon-server` remains a combined local compatibility binary.

## Target Write Flow

1. User edits data in the client.
2. Client Engine creates an operation.
3. Client Engine applies the operation locally.
4. Client stores the projected record and pending operation in PGlite.
5. Sync loop sends pending operations to `POST /api/engine/push`.
6. Server Engine validates and applies operations.
7. Server stores accepted operations with `remote_sequence`.
8. Server returns accepted/rejected/conflict decisions.
9. Client marks accepted operations in PGlite.
10. Client records rejected/conflict decisions for product-level resolution.

## Target Pull Flow

1. Client keeps a durable Engine cursor in PGlite.
2. Sync loop calls `POST /api/engine/pull` with the cursor.
3. Server returns accepted operations after the cursor.
4. Client applies pulled operations through the local Engine runtime.
5. Client updates local projections in PGlite.
6. Client advances the cursor only after local apply succeeds.

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
- Prefer a native bridge to the Rust Engine crate when the platform allows it.
- Keep local durable storage on-device so edits survive app restarts and bad
  network conditions.
- Sync over the same Engine server endpoints:
  - `POST /api/engine/push`
  - `POST /api/engine/pull`
- Make iPad layout a primary product surface for workspace/table/document flows.
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

- Run integration smoke against a real TiDB endpoint.
- Confirm table DDL against TiDB SQL mode.
- Add deployment docs for TLS and connection parameters.
- Add migration/version tracking for Engine tables.

### 7. Observability

- Log push/pull counts, accepted/rejected/conflict counts, and cursor movement.
- Add health/debug endpoint for Engine storage backend.
- Add client-side sync status:
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
