# Photon v0.2 Release Checklist

Photon v0.2 release readiness is based on workspace flows, not isolated UI
screens. A release candidate should keep record, chat, editor, file metadata,
and sync behavior working together across web and Tauri assumptions.

## Required Verification

Run these checks before marking the release candidate ready:

```bash
npm run type-check
npm test
npm run build
npm run type-check:worker
npm run test:e2e
cargo test --workspace
```

The GitHub `CI` workflow must also be green on the release commit. It covers the
same frontend, worker, browser E2E, and server gates, plus lint, server clippy,
server release build, and a Linux Tauri smoke build.

## Local Development Matrix

Default Rust server development:

```bash
cargo run --bin photon-server
npm run dev -- --host 127.0.0.1
```

Cloudflare Worker sync development:

```bash
npm run worker:dev
npm run dev:cf-sync -- --host 127.0.0.1
```

Desktop smoke:

```bash
npm run tauri:build
```

## Release Decision Gates

- Record creation, detail editing, and table filtering work in one tab and sync
  to another tab.
- Chat can stream an assistant response and record tools can create, move, and
  search workspace records.
- Docs can create a collaborative document, persist title metadata, sync editor
  blocks to another client, and link selected text back to records and chat
  context.
- Attachments persist metadata through the server and surface again from record,
  chat, and document views. Binary bytes remain provider-owned.
- Offline-ish document edits reconnect and sync after the client comes back
  online.
- Web builds use explicit API and WebSocket endpoints, and Tauri builds do not
  sync absolute local filesystem paths.

## Residual Risks

- Attachment byte storage is still a provider contract. Local web development
  keeps preview bytes in runtime object URLs, so CI proves metadata sync and
  chips, not durable binary download.
- The Rust server now has a service-level auth boundary (`PHOTON_AUTH_TOKENS`
  bearer tokens with tenant grants on Engine push/pull/debug and Live `/ws`,
  strict `tenant:{t}:workspace:{w}` scope enforcement), a per-operation
  `EnginePolicy` hook for domain-level write rules, and audit metadata stamped
  into every accepted operation. What remains is wiring Tachyon's real user
  sessions into an `EnginePolicy` implementation. Legacy record/chat/attachment
  REST endpoints remain open.
- Playwright covers Chromium workspace flows only. Native desktop packaging is
  covered by Tauri smoke builds, not full desktop UI automation.
- Offline coverage now includes the Engine round trip (offline record write →
  reload → reconnect → second client convergence) and two disconnected writers
  converging through the server. Same-record long-lived conflict resolution is
  covered deterministically at the Rust integration level
  (`crates/photon-engine/tests/sync_integration.rs`), not yet through browser
  UI automation.
- PGlite multi-tab is handled by `createSharedLocalStore`: one context opens
  the database, the rest forward to it over BroadcastChannel, and the next
  context in the Web Locks queue is promoted when the owner closes. Other
  contexts' writes reach each client's projection through
  `LocalStore.subscribe`, so tabs agree without a server round trip.
  `createPGliteStore({ exclusiveLock: true })` remains for hosts that would
  rather refuse a second tab than coordinate one. Two things are still future
  work:
  - Every context runs its own sync loop, so N tabs poll N times — harmless,
    because the durable cursor is monotonic and every write is idempotent,
    but wasteful.
  - A shared store hands other contexts the resulting *record*, not the
    operation, so a receiving client does not re-merge through the kernel.
    Two tabs editing different fields of one record at the same moment
    therefore leave the local record showing only the later write. Both
    operations are stored and pushed, so the server merges them and the pull
    corrects it — but offline, the local record stays wrong until reconnect.
    Broadcasting operations instead would need the two tabs to stop sharing
    one `actorId`, or their hybrid timestamps can collide.
