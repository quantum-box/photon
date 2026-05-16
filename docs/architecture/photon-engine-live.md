# Photon Engine and Photon Live

Photon separates sync into two product-facing layers.

For the implementation checklist of client Engine to server Engine sync, see
[`photon-engine-sync-plan.md`](./photon-engine-sync-plan.md).

## Photon Engine

Photon Engine is the durable data mutation path.

End users experience it as:

- Work can be created, edited, and deleted even when the network is unstable.
- Changes are kept locally instead of being lost.
- When the connection returns, pending work is synced to the server.
- Changes from other devices can be pulled back in.
- Conflicts and rejections are recorded so the app can resolve them intentionally.

Engineering responsibilities:

- durable local persistence
- append-only operation log
- materialized record projections
- sync cursors
- push/pull sync protocol
- conflict and rejection state
- snapshot/update streams for collaborative payloads that need durable replay

Photon Engine does not own WebSocket rooms, presence, cursors, awareness, or UI transport policy.

## Photon Live

Photon Live is the realtime collaborative UX path.

End users experience it as:

- Other people appear online in the same workspace or document.
- Edits show up quickly across open clients.
- Presence and awareness make the workspace feel shared.
- If the connection drops, the local UI can continue working.
- After reconnect, local realtime state is flushed back to the room.

Engineering responsibilities:

- WebSocket or Durable Object room connections
- Yjs update broadcast and replay for active rooms
- IndexedDB-backed local editor state
- presence and online counts
- awareness/cursor state
- reconnect behavior
- notifications that wake up Engine sync sooner

Photon Live does not decide canonical domain truth, validate business rules, or resolve durable conflicts.

## REST/RPC API

The API layer sits outside Engine and Live.

It owns:

- bootstrap and workspace metadata
- authentication and authorization
- special commands and AI/tool actions
- domain validation
- sync endpoints for Engine push/pull
- operational routes for files, search, billing, and admin flows

## Offline Behavior

```txt
Offline
- Engine accepts durable local mutations and keeps them pending.
- Live keeps local editing state usable and pauses transport/presence.

Reconnect
- Engine pushes/pulls pending durable operations.
- Live reconnects rooms and flushes local Yjs state.
```

The product rule is simple: Photon should not lose work when the network is bad, and it should feel collaborative when the network is available.
