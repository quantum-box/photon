# Photon Server Deploy

Photon's Rust application server lives in `packages/server`. It owns the
canonical issue REST API (`/api/issues`) and can also serve the local Yjs
WebSocket endpoint (`/ws`).

## Container

Build the server image locally:

```bash
docker build -f packages/server/Dockerfile -t photon-server:local packages/server
```

Run it locally:

```bash
docker run --rm -p 3001:8080 photon-server:local
curl http://127.0.0.1:3001/api/health
```

The container reads:

- `PORT`: HTTP listen port. Defaults to `8080` in the container and `3001` when
  running `cargo run` locally.
- `DATABASE_URL`: SQLite URL. The container default is
  `sqlite:/tmp/photon.db?mode=rwc`.

The default SQLite database is suitable for preview/demo deployments only. Cloud
Run filesystem data is ephemeral, so production issue data needs a durable
database URL once Photon moves beyond preview.

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
VITE_PHOTON_API_BASE_URL=https://<cloud-run-service-url>
```

If the Rust server should also provide sync, set:

```bash
VITE_PHOTON_SYNC_WS_URL=wss://<cloud-run-service-host>/ws
```

If Cloudflare Durable Objects remain the sync relay, keep
`VITE_PHOTON_SYNC_WS_URL` pointed at the Worker instead.
