# Three-Tier Local Sync Lab

Photon Engine / Photon Live を本番に近い三層構成でローカル検証するための
実験メモ。

## 想定アーキテクチャ

```text
Client
  - Web / Tauri / mobile
  - local Engine runtime
  - PGlite pending operation log
  - Photon Live client

    |
    | HTTPS / WebSocket
    v

Edge server
  - public ingress
  - TLS / auth session check / rate limit
  - Photon Live WebSocket room when edge-hosted
  - Engine push/pull proxy
  - no durable truth

    |
    | private HTTP / service auth
    v

Cloud server
  - Photon Engine authority
  - business/domain validation
  - permission and workspace scope checks
  - accepted operation log
  - conflict policy and audit metadata

    |
    v

TiDB / MySQL / durable database
```

The key rule: Edge can be fast and close to the user, but it must not become the
canonical application server. Durable acceptance belongs to the cloud server.

## Local Ports

| Layer | Local command | Port | Purpose |
| --- | --- | --- | --- |
| Client | `npm run dev` | `5173` | React app |
| Edge Worker | `npm run worker:dev` | `8787` | Photon Live Worker / future Engine proxy |
| Cloud Engine | `npm run server:engine` | `3001` | Engine authority API |
| Cloud Live | `npm run server:live` | `3002` | Rust Live server alternative |
| MySQL | Docker `mysql:8.0.35` | `3307` | TiDB stand-in |

## Current Local Lab

This is possible with the current code after PR #33:

```text
Client
  -> Edge Worker for Photon Live `/ws`
  -> Cloud Engine directly for `/api/engine/push` and `/api/engine/pull`
  -> MySQL
```

This validates the cloud authority and database path, but not the Engine proxy
inside the edge layer yet.

### 1. Start MySQL

```bash
docker run --name photon-engine-mysql \
  -e MYSQL_ROOT_PASSWORD=photon_root \
  -e MYSQL_DATABASE=photon_engine \
  -e MYSQL_USER=photon \
  -e MYSQL_PASSWORD=photon_pass \
  -p 127.0.0.1:3307:3306 \
  -d mysql:8.0.35
```

If the container already exists:

```bash
docker start photon-engine-mysql
```

### 2. Start Cloud Engine

```bash
PHOTON_ENGINE_PORT=3001 \
PHOTON_ENGINE_APP_DATABASE_URL=sqlite:photon-engine-app.db?mode=rwc \
PHOTON_ENGINE_DATABASE_URL=mysql://photon:photon_pass@127.0.0.1:3307/photon_engine \
  npm run server:engine
```

### 3. Smoke Cloud Engine

```bash
PHOTON_ENGINE_SMOKE_URL=http://127.0.0.1:3001 \
PHOTON_ENGINE_SMOKE_SCOPE=workspace:mysql-smoke \
  npm run server:engine:smoke
```

Expected result:

```json
{"ok":true,"remoteSequence":1}
```

`remoteSequence` may be higher when the database already contains accepted
operations.

### 4. Start Edge Worker For Live

```bash
npm run worker:dev
```

### 5. Start Client Against Edge Live And Cloud Engine

```bash
VITE_PHOTON_SYNC_WS_URL=ws://127.0.0.1:8787/ws \
VITE_PHOTON_API_BASE_URL=http://127.0.0.1:3001 \
  npm run dev -- --host 127.0.0.1
```

This keeps Live traffic on the edge Worker and Engine sync traffic on the cloud
Engine server.

## Target Local Lab

The next implementation step should make this possible:

```text
Client
  -> Edge Worker
       /ws
       /api/engine/push
       /api/engine/pull
  -> Cloud Engine
  -> MySQL
```

The client should point only at the edge:

```bash
VITE_PHOTON_SYNC_WS_URL=ws://127.0.0.1:8787/ws \
VITE_PHOTON_API_BASE_URL=http://127.0.0.1:8787 \
  npm run dev -- --host 127.0.0.1
```

The edge Worker should forward:

| Edge route | Cloud route |
| --- | --- |
| `POST /api/engine/push` | `POST http://127.0.0.1:3001/api/engine/push` |
| `POST /api/engine/pull` | `POST http://127.0.0.1:3001/api/engine/pull` |
| `GET /api/health` | `GET http://127.0.0.1:3001/api/health` or edge-local health |

## Edge Proxy Requirements

Minimum behavior:

- Pass through JSON request/response bodies unchanged.
- Preserve `content-type: application/json`.
- Add or forward request IDs for tracing.
- Enforce request size limits.
- Keep CORS explicit for local dev.
- Do not mutate operation payloads.
- Do not assign `remote_sequence`.
- Do not write durable Engine state.

Later production behavior:

- Verify session or signed workspace token.
- Rate-limit by user/workspace/device.
- Forward tenant/workspace identity to the cloud server.
- Use service-to-service auth between edge and cloud.
- Surface cloud errors without treating them as accepted operations.

## Cloud Authority Requirements

The cloud server owns durable acceptance:

- Validate actor identity.
- Validate workspace scope.
- Validate collection permissions.
- Validate schema and domain transitions.
- Attach audit metadata.
- Decide accepted / rejected / conflict / server patch.
- Persist accepted operation log and projection.
- Return the cursor clients should store.

The current `push_engine_operations` path accepts operations directly. That is
fine for the lab, but the production shape needs a domain validation boundary
between parsed Engine operations and storage writes.

## Verification Matrix

| Scenario | Current code | Target after edge proxy |
| --- | --- | --- |
| MySQL adapter DDL | supported | supported |
| Cloud Engine push/pull smoke | supported | supported |
| Client direct Engine push | supported | optional |
| Client Engine push through edge | not yet | required |
| Live WebSocket on edge Worker | supported | supported |
| Edge request ID propagation | not yet | required |
| Edge auth/session check | not yet | required |
| Cloud business validation boundary | partial | required |
| Pull apply and durable cursor on client | not yet | required |

## Suggested Implementation Tasks

1. Add Worker env config:
   - `PHOTON_CLOUD_ENGINE_BASE_URL`
   - optional `PHOTON_EDGE_SERVICE_TOKEN`
2. Add Worker routes:
   - `GET /api/health`
   - `POST /api/engine/push`
   - `POST /api/engine/pull`
3. Add Worker tests for pass-through proxy behavior.
4. Add cloud server request ID logging for push/pull.
5. Add a domain validation boundary in `packages/server`.
6. Add client pull apply and cursor persistence.
7. Add a Playwright or Node smoke that starts:
   - MySQL
   - cloud Engine
   - edge Worker
   - client or smoke script pointed at the edge

## Stop Conditions

The local three-tier lab is credible when:

- Client can push to `http://127.0.0.1:8787/api/engine/push`.
- Edge forwards to cloud without changing operation JSON.
- Cloud accepts the operation and writes to MySQL.
- Client can pull from `http://127.0.0.1:8787/api/engine/pull`.
- Live `/ws` still works through the same edge Worker.
- Stopping the edge does not corrupt cloud Engine state.
- Restarting cloud Engine preserves accepted operations from MySQL.
