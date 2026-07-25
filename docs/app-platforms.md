# App Platform Builds

Photon ships from the same React/Tauri codebase to web, desktop, Android, and
iOS. The repo treats each branded product as an app profile plus a deployment
topology:

- App profile: labels, navigation, record defaults, storage keys, and sync room
  names in `src/app/kitConfig.ts`.
- Frontend Worker: a required frontend-side edge companion for health checks,
  `/ws`, and future frontend-owned API glue.
- Application server: the canonical Rust API server, or an external API that
  implements the same record contract.
- Sync backend: either the Rust server WebSocket endpoint or Cloudflare Durable
  Objects behind the frontend Worker.

Production app builds point at the hosted sync Worker:

```text
wss://photon-sync.quantum-box.workers.dev/ws
```

The production Worker endpoint is stored in `.env.production` so Vite builds
work from macOS, Linux, and Windows shells.

Web release candidates must pass `npm run build` and keep API/WebSocket
endpoints explicit through Vite environment variables or `src/app/kitConfig.ts`.
Tauri release candidates must pass the CI Linux smoke build and should use
`tauri-local-file-cache` for desktop attachment byte references. Synced
attachment metadata must not contain absolute local filesystem paths.

Mobile release candidates must also pass the phone-viewport browser smoke:

```bash
npm run test:e2e:mobile
```

CI runs an Android APK smoke build for `aarch64` so the Tauri mobile wrapper,
Rust command bridge, WASM frontend build, and generated Android project stay in
sync with the shared app shell.

Release following for apps that should avoid the npm registry is documented in
[`release-following.md`](./release-following.md).

## App Profiles

When creating another app from Photon, start by changing only
`src/app/kitConfig.ts`:

- `app.id`, `displayName`, and `storageNamespace`
- `workspace.name`, navigation, projects, and users
- `records.identifierPrefix` and `defaultProject`
- `chat.productName` and disclaimer copy
- explicit storage and sync keys

Do not scatter product names, storage keys, or endpoint paths into components.
The UI should consume `appKitConfig`, and runtime wiring should stay behind the
same config helpers.

## Deployment Topologies

Use `VITE_PHOTON_DEPLOYMENT_MODE` to document the intended topology for a build:

| Mode | Frontend Worker | Sync default | App API default |
| --- | --- | --- | --- |
| `local` | Cloudflare Worker dev server | Rust server `/ws` | Rust server |
| `cloud` | Cloudflare Workers | Durable Object relay | Rust server or external API |
| `onprem` | `workerd` container | Rust server `/ws` | Rust server |

The Frontend Worker is always part of the frontend platform contract. In cloud
deployments it runs on Cloudflare Workers. In on-premise deployments, run the
same Worker boundary through `workerd` (or a compatible Workers runtime) next to
the static frontend assets.

Recommended on-premise shape:

```text
browser / desktop / mobile
  -> TLS ingress (Caddy, Nginx, Traefik, or appliance LB)
  -> frontend bundle + workerd Frontend Worker
       /api/health
       /ws
       static assets
  -> Rust app server
       /api/engine/push
       /api/engine/pull
       optional /ws sync
  -> durable database volume or managed on-prem database
```

For a strict offline/on-prem install, keep sync on the Rust server and persist
the server database outside the container. For a connected private-cloud install
that is allowed to reach Cloudflare, the sync backend can still be overridden to
`cloudflare-durable-object`.

Useful environment variables:

```bash
VITE_PHOTON_DEPLOYMENT_MODE=onprem
VITE_PHOTON_FRONTEND_WORKER_RUNTIME=workerd
VITE_PHOTON_SYNC_BACKEND=rust-server
VITE_PHOTON_API_BASE_URL=https://photon.example.internal
VITE_PHOTON_SYNC_WS_URL=wss://photon.example.internal/ws
```

## Desktop

Build a local desktop bundle:

```bash
npm run tauri:build
```

Create a GitHub desktop release by pushing a semver tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The `Release` workflow builds desktop bundles for macOS, Linux, and Windows and
publishes the GitHub Release when all platform builds finish. It also runs
automatically after `CI` passes on `main`: if `package.json` has a version that
does not already have a matching `vX.Y.Z` tag, the workflow creates that tag and
publishes the desktop release.

## Android

The Android project lives under `src-tauri/gen/android`.

```bash
npm run tauri:android:dev
npm run tauri:android:build
npm run tauri:android:build -- --target aarch64 --apk
```

The generated Android manifest includes Internet permission so the bundled app
can connect to the Cloudflare sync Worker.

If `JAVA_HOME` points at an old or missing JDK, use Android Studio's bundled
JBR for the build:

```bash
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
PATH="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin:$PATH" \
npm run tauri:android:build -- --target aarch64 --apk
```

## iOS

The iOS project lives under `src-tauri/gen/apple`.

```bash
npm run tauri:ios:dev
npm run tauri:ios:build -- --target aarch64-sim
npm run tauri:ios:build:sim
```

CI uses `npm run tauri:ios:build:sim` as the unsigned simulator smoke build.
This catches regressions in the shared React bundle, Tauri mobile wrapper, and
Rust command bridge without requiring App Store signing.

Code signing uses the Quantum Box Apple development team configured in
`src-tauri/tauri.conf.json`. Set `APPLE_DEVELOPMENT_TEAM` in CI or the shell to
override it for a different team.

Use the generated Xcode project for device archive and App Store signing:
`src-tauri/gen/apple/photon.xcodeproj`.
