# Cloudflare Sync Backend

Photon can run its current Rust sync server for local and Cloud Run style
deployments, or use a Cloudflare Workers + Durable Objects relay for `/ws`.

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

## Follow-up Work

- Add room selection to the frontend once Photon has multiple workspaces/docs.
- Compact the update log by periodically materializing a Yjs snapshot.
- Decide whether durable issue metadata should live in Durable Object storage,
  D1, or the Rust backend.
- Add a Cloudflare-specific E2E path once a preview deployment exists.
