# Photon Server Deploy

Photon's Rust servers live in `crates/photon-axum`. Production should deploy the
Engine and Live roles separately, usually behind an edge ingress:

```text
Client
  -> edge server / Worker / ingress
       - TLS, auth/session checks, rate limits
       - Photon Live WebSocket rooms when edge-hosted
       - Engine push/pull proxy
  -> cloud server
       - Photon Engine authority
       - business/domain validation
       - durable database writes
  -> TiDB/MySQL or another production database
```

- `photon-engine-server`: durable Engine API (`/api/*`, Swagger UI)
- `photon-live-server`: realtime Live WebSocket (`/ws`)
- `photon-server`: compatibility server that runs both roles in one process

## Container

Build the compatibility server image locally:

```bash
docker build -f crates/photon-server/Dockerfile -t photon-server:local .
```

Build role-specific images:

```bash
docker build \
  -f crates/photon-server/Dockerfile \
  --build-arg PHOTON_SERVER_BIN=photon-engine-server \
  -t photon-engine-server:local \
  .

docker build \
  -f crates/photon-server/Dockerfile \
  --build-arg PHOTON_SERVER_BIN=photon-live-server \
  -t photon-live-server:local \
  .
```

Run it locally:

```bash
docker run --rm -p 3001:8080 photon-server:local
curl http://127.0.0.1:3001/api/health
```

Run the roles locally without Docker:

```bash
npm run server:engine
PHOTON_LIVE_PORT=3002 npm run server:live
```

Smoke the Engine API after `npm run server:engine` is listening:

```bash
npm run server:engine:smoke
```

Set `PHOTON_ENGINE_SMOKE_URL` when the Engine service is not on
`http://127.0.0.1:3001`.

The container reads:

- `PORT`: HTTP listen port. Defaults to `8080` in the container and `3001` when
  running `cargo run` locally.
- `PHOTON_ENGINE_PORT`: Engine-only local listen port. Defaults to `3001`.
- `PHOTON_LIVE_PORT`: Live-only local listen port. Defaults to `3002`.
- `DATABASE_URL`: SQLite URL. The container default is
  `sqlite:/tmp/photon.db?mode=rwc`.
- `PHOTON_ENGINE_APP_DATABASE_URL`: Engine-role app-domain SQLite database URL
  override. This is separate from the Engine sync store and mainly keeps local
  previews isolated.
- `PHOTON_ENGINE_DATABASE_URL`: Engine storage URL override. Use
  `mysql://user:password@host:4000/database` for MySQL or
  `tidb://user:password@host:4000/database` for TiDB. `tidb://` is normalized
  to the MySQL driver at startup.
- `PHOTON_LIVE_DATABASE_URL`: Live-only SQLite database URL override for Yjs
  room state.
- `PHOTON_LIVE_ENGINE_DATABASE_URL`: optional Engine storage URL for Live when
  Live needs the same durable snapshot/update storage as Engine.
- `PHOTON_AUTH_TOKENS`: comma-separated bearer tokens the server trusts, e.g.
  `edge-token,acme-token@acme`. A bare token is granted every tenant; a
  `token@tenant` entry is confined to that tenant. When set, `/api/engine/push`,
  `/api/engine/pull`, `/api/engine/debug`, and `/ws` all require
  `Authorization: Bearer <token>` (Live sockets may pass `?token=` instead,
  since browsers cannot set WebSocket headers), the request scope must be
  `tenant:{tenant}:workspace:{workspace}`, and the token's tenant grant is
  enforced against it. Unset disables authentication — local development only;
  the server logs a warning at startup.
- `PHOTON_CORS_ALLOWED_ORIGINS`: comma-separated exact origins for CORS.
  Unset or `*` allows any origin.

The default SQLite database is suitable for preview/demo deployments only. Cloud
Run filesystem data is ephemeral, so production record data needs a durable
database URL once Photon moves beyond preview.

For production Engine deployments, prefer TiDB/MySQL. The server connects,
prepares Engine schema, and performs a startup storage probe before it starts
accepting HTTP traffic:

```bash
PHOTON_ENGINE_DATABASE_URL=tidb://<user>:<password>@<tidb-host>:4000/photon \
  npm run server:engine
```

Engine schema preparation runs versioned migrations from the Rust adapter at
process startup: each migration is recorded in
`photon_engine_schema_migrations`, re-running is a no-op, and future schema
changes ship as new numbered entries rather than edits to released DDL. The
statements are individually idempotent, so an interrupted MySQL/TiDB migration
(their DDL is not transactional) is repaired by simply starting the process
again. Treat that adapter as the storage implementation behind cloud-server
business logic. Incoming Engine operations pass the service auth boundary
(`PHOTON_AUTH_TOKENS`: bearer token, strict scope shape, tenant grant), are
evaluated as a complete push batch against the host-supplied `EnginePolicy`
(`build_state_with_auth_and_policy`; the default allows what the token grant
allows). A policy can override the batch hook to avoid per-operation network
lookups; policy infrastructure failures return 503 and persist no decisions.
Each accepted operation is stamped with typed `metadata.photon_audit`
(principal type, service grant, tenant, workspace, server request id, receive
time) before entering the log. Client metadata must be an object or null, so an
operation can never be accepted without its server-owned audit stamp.
When user identity is connected, store only the verified stable opaque user id;
never stamp a token, email address, display name, or other profile data.
Domain rules — per-user permissions, collection rules, schema validation,
conflict policy — belong in the host's `EnginePolicy` implementation. App-domain SQLite migrations under
`crates/photon-axum/migrations/` are still for the local compatibility app
database; they are not the TiDB Engine schema source.

Local MySQL can stand in for TiDB when validating the production storage path:

```bash
docker run --name photon-engine-mysql \
  -e MYSQL_ROOT_PASSWORD=photon_root \
  -e MYSQL_DATABASE=photon_engine \
  -e MYSQL_USER=photon \
  -e MYSQL_PASSWORD=photon_pass \
  -p 127.0.0.1:3307:3306 \
  -d mysql:8.0.35

PHOTON_ENGINE_MYSQL_TEST_DATABASE_URL=mysql://photon:photon_pass@127.0.0.1:3307/photon_engine \
  cargo test -p photon-engine --features mysql \
  mysql_adapter_satisfies_storage_contract_when_url_is_configured
```

Photon Engine exposes durable push/pull sync endpoints:

- `POST /api/engine/push`: accept pending client operations and return decisions.
- `POST /api/engine/pull`: return accepted operations after the client's cursor.
- `GET /api/engine/debug`: local/development observability for accepted counts,
  collection counts, cursor position, next remote sequence, and recent
  operations.

Photon Live does not expose these Engine endpoints. It only owns `/ws`.

## Server Roles

Use these roles in production:

| Role | Binary | Endpoints | Storage |
| --- | --- | --- | --- |
| Edge | Worker, ingress, or lightweight Rust edge role | public TLS, rate limit, auth/session check, Engine proxy; `/ws` only after principal-aware authentication | no durable truth |
| Engine | `photon-engine-server` on cloud server | `/api/health`, `/api/engine/push`, `/api/engine/pull`, REST APIs | cloud business logic, then `PHOTON_ENGINE_DATABASE_URL`, TiDB/MySQL preferred |
| Live | `photon-live-server` or edge-hosted Live room | `/ws` | `PHOTON_LIVE_DATABASE_URL` for room state; optional `PHOTON_LIVE_ENGINE_DATABASE_URL` |
| Test/mock | `mock-tachyon-api` | `/v1/sync/push`, `/v1/sync/pull`, admin scenario routes | SQLite only, local scenario verification |
| Compatibility | `photon-server` | Engine + Live in one process | local preview and development |

`mock-tachyon-api` is not a production Engine server. Keep it for deterministic
scenario tests and dashboard verification.

For a local lab that runs the Client -> Edge -> Cloud Server -> DB shape, see
[`architecture/three-tier-local-sync-lab.md`](./architecture/three-tier-local-sync-lab.md).

## GitHub Actions Cloud Run Deploy

`.github/workflows/server-deploy.yml` builds `crates/photon-server/Dockerfile`, pushes
the image to Artifact Registry, and deploys it to Cloud Run.

Required repository variables:

| Variable | Example | Purpose |
| --- | --- | --- |
| `GCP_PROJECT_ID` | `quantum-box-prod` | Google Cloud project |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/.../providers/github` | GitHub OIDC provider |
| `GCP_SERVICE_ACCOUNT` | `photon-deploy@...iam.gserviceaccount.com` | Deploy service account |

Optional repository variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GCP_REGION` | `asia-northeast1` | Cloud Run region |
| `CLOUD_RUN_SERVICE` | `photon-server` | Cloud Run service name |
| `GCP_ARTIFACT_LOCATION` | same as region | Artifact Registry location |
| `GCP_ARTIFACT_REPOSITORY` | `photon` | Artifact Registry repository |
| `PHOTON_SERVER_DATABASE_URL` | `sqlite:/tmp/photon.db?mode=rwc` | Server `DATABASE_URL` |

Run the deployment manually from GitHub Actions with **Server Deploy**. The
workflow also runs automatically on `main` when server files change.

## Frontend Runtime Wiring

For a deployed frontend, set:

```bash
VITE_PHOTON_API_BASE_URL=https://<engine-service-url>
```

For Photon Live, set:

```bash
VITE_PHOTON_SYNC_WS_URL=wss://<live-service-host>/ws
```

If Cloudflare Durable Objects remain the sync relay, keep
`VITE_PHOTON_SYNC_WS_URL` pointed at the Worker instead.
