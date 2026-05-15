# Photon Server Deploy

Photon's Rust servers live in `packages/server`. Production should deploy the
Engine and Live roles separately:

- `photon-engine-server`: durable Engine API (`/api/*`, Swagger UI)
- `photon-live-server`: realtime Live WebSocket (`/ws`)
- `photon-server`: compatibility server that runs both roles in one process

## Container

Build the compatibility server image locally:

```bash
docker build -f packages/server/Dockerfile -t photon-server:local packages/server
```

Build role-specific images:

```bash
docker build \
  -f packages/server/Dockerfile \
  --build-arg PHOTON_SERVER_BIN=photon-engine-server \
  -t photon-engine-server:local \
  packages/server

docker build \
  -f packages/server/Dockerfile \
  --build-arg PHOTON_SERVER_BIN=photon-live-server \
  -t photon-live-server:local \
  packages/server
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

The container reads:

- `PORT`: HTTP listen port. Defaults to `8080` in the container and `3001` when
  running `cargo run` locally.
- `PHOTON_ENGINE_PORT`: Engine-only local listen port. Defaults to `3001`.
- `PHOTON_LIVE_PORT`: Live-only local listen port. Defaults to `3002`.
- `DATABASE_URL`: SQLite URL. The container default is
  `sqlite:/tmp/photon.db?mode=rwc`.
- `PHOTON_ENGINE_DATABASE_URL`: Engine storage URL override. Use
  `mysql://user:password@host:4000/database` for TiDB/MySQL.
- `PHOTON_LIVE_DATABASE_URL`: Live-only database URL override.

The default SQLite database is suitable for preview/demo deployments only. Cloud
Run filesystem data is ephemeral, so production issue data needs a durable
database URL once Photon moves beyond preview.

For production Engine deployments, prefer TiDB/MySQL:

```bash
PHOTON_ENGINE_DATABASE_URL=mysql://<user>:<password>@<tidb-host>:4000/photon \
  npm run server:engine
```

Photon Engine exposes durable push/pull sync endpoints:

- `POST /api/engine/push`: accept pending client operations and return decisions.
- `POST /api/engine/pull`: return accepted operations after the client's cursor.

Photon Live does not expose these Engine endpoints. It only owns `/ws`.

## GitHub Actions Cloud Run Deploy

`.github/workflows/server-deploy.yml` builds `packages/server/Dockerfile`, pushes
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
