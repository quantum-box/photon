# Photon Engine

Photon Engine is the private Rust core for local-first durable sync across Photon and Tachyon runtimes. It is the **durable truth** layer: local mutations, append-only operations, projections, cursors, conflicts, and push/pull reconciliation.

Photon Engine intentionally does not own realtime collaboration UX. That layer is **Photon Live**: WebSocket rooms, Durable Object rooms, Yjs awareness, presence, cursors, and immediate multi-user feedback. Photon Live can wake the engine up or mirror accepted state, but it should not become part of this crate.

In short:

- Photon Engine keeps work safe when the network is unreliable.
- Photon Live makes collaboration feel instant while people are online.
- REST/RPC APIs bootstrap workspaces, auth, commands, and sync endpoints.

## Current Boundary

- Generic `record`, `operation`, `cursor`, and `conflict` types.
- Deterministic projection from append-only operations.
- Storage adapter contract with idempotent operation append, cursor persistence, record projection persistence, and conflict persistence.
- In-memory adapter for contract tests.
- Optional SQLite adapter behind the `sqlite` feature for server/Tauri usage.
- No WebSocket connection management, awareness, presence, room membership, or UI transport policy.

## Feature Flags

- `memory` is enabled by default and provides `MemoryAdapter`.
- `sqlite` enables `SqliteAdapter`. Keep this feature out of browser/WASM builds.

## Verification

```sh
cargo test
cargo test --features sqlite
```

## Packaging Policy

This crate is private by default (`publish = false`). Public exposure should be split later into a protocol spec, thin SDK, or examples rather than publishing the conflict resolver and storage core wholesale.
