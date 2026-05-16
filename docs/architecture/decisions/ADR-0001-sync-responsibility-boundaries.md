# ADR-0001: Sync Responsibility Boundaries

## Status

Accepted (2026-05-08)

## Context

Photon は React/Vite/Tauri frontend、Yjs local-first state、Cloudflare Workers + Durable Objects sync relay、Rust axum + SQLite backend を持っている。

現状の frontend は `src/lib/yjs/yjsProvider.ts` で単一の `Y.Doc` を作り、`y-indexeddb` で `photon-issues` に保存し、`/ws` に Yjs binary update を送っている。`src/contexts/IssuesContext.tsx` の issue CRUD は REST API ではなく Yjs document を直接更新する。

Cloudflare sync backend は `workers/sync/index.ts` で `/ws` を Durable Object room に routing し、opaque な Yjs update を保存、replay、broadcast する。presence は WebSocket connection 数から計算する。この backend は update payload を domain data として解釈しない。

Rust server は `packages/server/src/main.rs` で `/api/issues` REST API、SQLite の `issues` table、yrs-based `/ws` sync endpoint を提供する。ただし frontend issue CRUD と Rust REST/SQLite issue data はまだ同じ write path ではない。これは次の issue で解消するべき split-brain である。

Photon Workspace v0.2 では issues だけでなく、Notion-like editor documents、attachments、chat messages、tool calls、workspace metadata も扱う。これらは realtime collaboration だけでなく、server-side persistence、permissions、audit、search、migration に乗る必要がある。

## Decision

Cloudflare Worker + Durable Object sync は frontend Yjs document の realtime consistency relay として扱う。canonical application server そのものにはしない。この realtime collaborative UX path を **Photon Live** と呼ぶ。

Durable mutation / offline sync / projection / conflict / replay の path を **Photon Engine** と呼ぶ。Photon Engine は durable truth を守り、Photon Live は shared experience を作る。

Photon の責務境界は次のように分ける。

| Surface | Canonical owner | Relay/cache role |
| --- | --- | --- |
| Workspace, project, user, permissions | Application server | Client cache only |
| Issues | Application server domain store | Yjs projection and optimistic local cache |
| Editor documents | Application server owned Yjs snapshot/update log, with optional block projection | Realtime Yjs room relay and local IndexedDB cache |
| Attachments | Object storage plus server metadata | Yjs references and preview cache |
| Chat messages, tool calls, tool results | Application server | Streaming UI cache; optional local draft cache |
| Presence, online count, cursors | Sync relay | Ephemeral only |
| Theme and personal UI preferences | Local client storage unless explicitly shared | No server authority by default |

The target architecture has three layers:

```mermaid
flowchart LR
  Client["Photon client\nReact/Tauri/mobile"]
  Engine["Photon Engine\ndurable mutations\noperation log\npush/pull sync"]
  Live["Photon Live\nYjs + WebSocket/DO\npresence + awareness"]
  Api["REST/RPC API\nbootstrap/auth/commands\nsync endpoint"]
  Store["Canonical stores\nSQLite/Postgres/D1\nobject storage\naudit/event log\nYjs snapshots"]
  Client <--> Engine
  Client <--> Live
  Client <--> Api
  Engine <--> Api
  Api <--> Store
  Live -. "realtime UX only" .-> Store
```

Photon Live can keep the UI responsive offline by using local Yjs/IndexedDB state, but its network responsibilities are opportunistic: presence, awareness, and broadcast pause while disconnected. Photon Engine keeps durable local mutations and reconciles them when the sync endpoint is reachable again.

### Production Server Roles

Production deployment treats Engine and Live as separate roles.

- `photon-engine-server` owns durable operation sync and exposes `/api/engine/push` and `/api/engine/pull`.
- `photon-live-server` owns realtime collaboration and exposes `/ws`.
- `photon-server` may run both roles together for local compatibility, but it is not the preferred production topology.

Photon Engine storage must be durable database storage. TiDB/MySQL is supported via `PHOTON_ENGINE_DATABASE_URL=mysql://...`; SQLite remains acceptable for local development and preview data only. Photon Live may share Engine storage for Yjs snapshot/update persistence, but its API surface remains realtime-only.

The client-side Engine runtime stores pending operations in PGlite. When the Engine server is reachable, the client pushes those pending operations to `/api/engine/push`; accepted decisions mark local operations as accepted. Pull sync uses `/api/engine/pull` with a cursor to receive accepted operations from other clients.

### Write Path

Domain writes must eventually be accepted by the application server.

For issue CRUD and other structured domain data, the target write path is:

1. Client applies an optimistic local mutation to Yjs/IndexedDB for instant UI.
2. Client sends a domain mutation to the application server.
3. Application server validates permissions, ids, status transitions, schema, and audit metadata.
4. Application server persists the canonical change and returns the accepted version.
5. Client reconciles local Yjs state with the accepted server version.
6. Sync relay broadcasts Yjs updates to other connected clients for realtime consistency.

During migration, Photon may temporarily materialize server projections from existing Yjs updates. That bridge is allowed only to remove current split-brain behavior; the long-term authority for structured domain data remains the application server.

For editor document content, Yjs can remain the collaboration data model, but the canonical copy must be stored and compacted by the application server or an application-owned storage path. Durable Object replay logs are not enough for long-term document truth.

### Read Path

Cold start and reconnect should follow this order:

1. Client authenticates with the application server.
2. Client loads workspace metadata, authorized document/issue rooms, and latest server snapshots or projections.
3. Client hydrates local Yjs/IndexedDB state from the accepted server version when needed.
4. Client connects to the sync relay for realtime updates.
5. Client reconciles remote Yjs updates with domain projections exposed by the application server.

Issue list/table/kanban screens may continue to render from Yjs for low-latency updates, but the app must be able to explain the same data from server-owned projections.

### Room And Authorization Model

Room ids are server-issued or server-derived. Clients should not invent durable room ids without server context.

The sync relay may verify a room token or signed room claim before accepting a WebSocket connection. That check only protects the realtime channel. Domain authorization, audit, and validation stay with the application server.

Room naming should reserve space for future surfaces:

- `workspace:{workspaceId}:issues`
- `workspace:{workspaceId}:doc:{docId}`
- `workspace:{workspaceId}:chat:{threadId}`

The exact encoding can change, but room ids must include workspace scope and surface scope.

## Consequences

### Positive

- Cloudflare Worker sync can stay small, fast, and replaceable.
- Frontend collaboration can remain local-first and responsive.
- The application server can own permissions, validation, audit, search, migrations, and integration APIs.
- Issues, documents, attachments, and chat/tool history can converge on one server data model instead of separate client-only islands.
- Future hosting choices are easier because relay transport and canonical data storage are separate decisions.

### Negative

- Some writes require both optimistic Yjs updates and server reconciliation.
- The current issue implementation needs migration work because Yjs and SQLite issue state are split.
- Editor content needs a real snapshot/compaction strategy beyond Durable Object bounded replay.
- Tests must cover both realtime client convergence and server canonical persistence.

### Neutral

- This ADR does not require replacing Yjs.
- This ADR does not require choosing the final production database.
- This ADR does not decide whether Rust, Tachyon Agent API, D1, or another service hosts the final application server.
- The Cloudflare relay can still be used in production as the realtime transport.

## Alternatives Considered

### Make Durable Object the canonical application server

Rejected. Durable Objects are a good room-local coordination primitive, but Photon needs domain validation, cross-room queries, audit, permissions, attachments, search, migrations, and integration APIs. Putting all of that behind opaque Yjs update replay would make server data harder to inspect and evolve.

### Make REST/SQLite the only source and remove Yjs local-first writes

Rejected. Photon's product direction depends on responsive local-first editing, realtime collaboration, and offline-friendly behavior. Removing Yjs would make the frontend simpler but would weaken the workspace experience.

### Keep frontend Yjs and Rust REST/SQLite as independent systems

Rejected. This is the current split-brain risk. It is acceptable only as an intermediate state while PoC features are being built.

### Persist only Yjs update logs forever

Rejected. Infinite replay gets slower over time and makes repair, migration, search, and server-side querying difficult. Long-lived content needs compaction into snapshots and, for domain entities, materialized projections.

## Follow-up

- PLT-1180: Resolve issue split-brain between frontend Yjs and Rust REST/SQLite.
- PLT-1181: Add workspace/document room model and route room ids through config.
- PLT-1182: Implement Yjs snapshot compaction and replay strategy. ✅ Done — DO + server compact at threshold, hydrate via snapshot + log replay; corrupt rows are skipped with a warning.
- PLT-1183: Build chat tools on top of the canonical issue write/read path.
- PLT-1186: Add Notion-like editor with server-owned document snapshots.
- PLT-1188: Move attachment metadata/storage into server-syncable domain data.
- PLT-1189: Add E2E/CI coverage for sync, persistence, chat tools, editor, and attachments.

## References

- `src/lib/yjs/yjsProvider.ts`
- `src/lib/yjs/useYjsIssues.ts`
- `src/contexts/IssuesContext.tsx`
- `workers/sync/index.ts`
- `packages/server/src/main.rs`
- `packages/server/migrations/001_create_issues.sql`
- `docs/cloudflare-sync.md`
