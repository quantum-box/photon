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

Cloudflare Worker Engine-proxy development and Live security check:

```bash
npm run worker:dev
npm run dev:cf-sync -- --host 127.0.0.1
```

The Worker `/ws` route must return HTTP 403 in this phase. End-to-end Live
behavior uses the authenticated Rust `/ws` endpoint until the Worker gains a
principal-aware session boundary.

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
  strict `tenant:{t}:workspace:{w}` scope enforcement), a batch-capable
  `EnginePolicy` hook for domain-level write rules, and typed audit metadata
  stamped into every accepted operation. The Cloudflare Worker `/ws` route is
  fail-closed until it has a principal-aware user-session boundary. What
  remains is wiring Tachyon's real user sessions into an `EnginePolicy`
  implementation. Legacy record/chat/attachment REST endpoints remain open.
- Playwright covers Chromium workspace flows only. Native desktop packaging is
  covered by Tauri smoke builds, not full desktop UI automation.
- Offline coverage now includes the Engine round trip (offline record write →
  reload → reconnect → second client convergence) and two disconnected writers
  converging through the server. Same-record long-lived conflict resolution is
  covered deterministically at the Rust integration level
  (`crates/photon-engine/tests/sync_integration.rs`), not yet through browser
  UI automation.
- PGlite multi-tab remains a known limitation: `createPGliteStore` now offers
  an opt-in `exclusiveLock` (Web Locks) that makes a second tab fail loudly
  instead of corrupting silently, but graceful multi-tab (leader election or a
  SharedWorker) is still future work.
