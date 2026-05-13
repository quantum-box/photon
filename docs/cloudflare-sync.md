# Cloudflare Sync Backend

Photon can run its current Rust sync server for local, on-premise, and Cloud Run
style deployments, or use a Cloudflare Workers + Durable Objects relay for
`/ws`.

The Worker is modeled as a frontend-side component rather than as Photon's
canonical application server. It is the edge companion for frontend runtime
concerns: `/ws`, `/api/health`, and future thin frontend-owned adapters. In
hosted cloud deployments this component runs on Cloudflare Workers. In on-premise
deployments, keep the same boundary and run it with `workerd` or a compatible
Workers runtime beside the frontend assets.

## Runtime Model

- Frontend keeps the same WebSocket contract: `/ws` receives Yjs binary updates
  and text presence messages.
- Rust backend remains the default local backend.
- Cloudflare backend routes `/ws` to a Durable Object room.
- Each Durable Object stores a bounded Yjs update log and replays it to newly
  connected clients.
- Presence is computed from the Durable Object WebSocket set and sent as:

```json
{ "type": "presence", "onlineCount": 2 }
```

The Cloudflare backend intentionally starts as a relay. It does not interpret
Yjs updates or compact them into a canonical Y.Doc snapshot yet.

The relay is not Photon's canonical application server. The responsibility
boundary between the frontend Yjs relay, application server, and durable domain
stores is recorded in
[`ADR-0001: Sync Responsibility Boundaries`](./architecture/decisions/ADR-0001-sync-responsibility-boundaries.md).

## Local Cloudflare Sync

Start the Durable Object worker:

```bash
npm run worker:dev
```

In another shell, start the frontend pointed at the worker:

```bash
npm run dev:cf-sync -- --host 127.0.0.1
```

Open two browser tabs at `http://127.0.0.1:5173/issues`.

Expected behavior:

- Sidebar shows `2 online`.
- Creating or editing an issue in one tab appears in the other tab.
- Refreshing a tab replays stored updates from the Durable Object room.

## Deploy

Deploy the worker:

```bash
npm run worker:deploy
```

Build the frontend with the deployed worker URL:

```bash
VITE_PHOTON_SYNC_WS_URL=wss://<worker-host>/ws npm run build
```

## On-Premise Sync

For on-premise installs, prefer this default unless the customer explicitly wants
Cloudflare-hosted sync:

```bash
VITE_PHOTON_DEPLOYMENT_MODE=onprem
VITE_PHOTON_FRONTEND_WORKER_RUNTIME=workerd
VITE_PHOTON_SYNC_BACKEND=rust-server
VITE_PHOTON_SYNC_WS_URL=wss://<onprem-host>/ws
VITE_PHOTON_API_BASE_URL=https://<onprem-host>
```

The ingress should route `/ws` to the Rust server when
`VITE_PHOTON_SYNC_BACKEND=rust-server`. Keep `/api/health` on the frontend Worker
so deployment checks can verify the frontend edge layer independently from the
application server.

## Follow-up Work

- Add room selection to the frontend once Photon has multiple workspaces/docs.
- Compact the update log by periodically materializing a Yjs snapshot.
- Add a `workerd` on-premise package once the first customer deployment shape is
  known.
- Decide whether durable issue metadata should live in Durable Object storage,
  D1, or the Rust backend.
- Add a Cloudflare-specific E2E path once a preview deployment exists.
