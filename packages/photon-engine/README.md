# Photon Engine

Photon Engine is the private Rust core for local-first durable sync across Photon and Tachyon runtimes.

The crate intentionally does not own realtime transport. WebSocket, Durable Object rooms, Yjs awareness, presence, and push notifications should call into this crate as triggers or adapters instead of becoming part of the core.

## Current Boundary

- Generic `record`, `operation`, `cursor`, and `conflict` types.
- Deterministic projection from append-only operations.
- Storage adapter contract with idempotent operation append, cursor persistence, record projection persistence, and conflict persistence.
- In-memory adapter for contract tests.
- Optional SQLite adapter behind the `sqlite` feature for server/Tauri usage.

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
