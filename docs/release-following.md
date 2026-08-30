# Following Photon Releases

Photon publishes to the npm registry as `@quantum-box/photon`, and every
release is also a Git tag. Both routes install the same tarball contents; pick
by what the consuming app's build environment can do.

## From the Registry

```bash
npm install @quantum-box/photon
```

The published tarball carries a prebuilt WASM kernel, so nothing in the
consuming app's toolchain needs Rust. Pin the way the app pins any dependency:

```json
{
  "dependencies": {
    "@quantum-box/photon": "^0.3.0"
  }
}
```

## From a Git Tag

Use this when the app must not depend on the registry, or needs a commit that
is not released yet:

```json
{
  "dependencies": {
    "@quantum-box/photon": "git+ssh://git@github.com/quantum-box/photon.git#v0.3.0"
  }
}
```

For a private GitHub repo, use SSH so the consuming app can rely on the deploy
key or machine user already configured for the app build.

Useful forms:

```bash
npm install git+ssh://git@github.com/quantum-box/photon.git#v0.3.0
npm install github:quantum-box/photon#v0.3.0
npm install git+ssh://git@github.com/quantum-box/photon.git#7f4a2c1
```

Use commit SHAs only for temporary verification branches. Do not leave app
production builds pinned to a moving branch such as `main`.

A Git install builds Photon from source, which is the one meaningful
difference between the two routes — see the toolchain requirement below.

## What Photon Exposes

The root package exposes stable platform entrypoints (see `exports` in
`package.json`):

```text
@quantum-box/photon
@quantum-box/photon/react
@quantum-box/photon/rest
@quantum-box/photon/store-pglite
@quantum-box/photon/wasm
@quantum-box/photon/worker
```

Example app wiring:

```ts
import { createPhotonClient, createEngineTransport } from '@quantum-box/photon'
import { createPGliteStore } from '@quantum-box/photon/store-pglite'
import { loadPhotonKernel } from '@quantum-box/photon/wasm'

const photon = await createPhotonClient({
  scope: buildWorkspaceScope({ tenantId, workspaceId }),
  actorId,
  storage: await createPGliteStore({ dataDir: 'idb://photon' }),
  kernel: await loadPhotonKernel(),
  transport: createEngineTransport({ baseUrl: apiBaseUrl }),
})
```

The `worker` entrypoint is for Cloudflare Workers or `workerd` compatible
runtimes. Do not import it from a plain Node.js process.

## What the Consuming App Must Provide

A registry install needs nothing beyond npm: the tarball ships the kernel
already built.

A Git dependency instead runs Photon's `prepare` script on install, and that
script builds the WASM kernel. The machine doing the install — a developer
laptop and every CI runner that runs `npm ci` — then needs a Rust toolchain
with the `wasm32-unknown-unknown` target and wasm-pack. There is no prebuilt
fallback for that route: the kernel is required, and a silent JavaScript
substitute would change merge semantics.

Dependencies split by who owns them:

- `@electric-sql/pglite` ships as a Photon dependency, so
  `@quantum-box/photon/store-pglite` works without app-side setup.
- `react` is an optional peer dependency. Apps using
  `@quantum-box/photon/react` already have it; core-only and server-side
  consumers are not forced to install it.

Photon verifies this contract from outside the workspace with
`npm run smoke:exports`, which packs the tarball, installs it into a throwaway
app, and imports and type-checks every entrypoint. The playground imports the
internal workspace names, so it cannot catch a broken public entrypoint.

Each app keeps only its app profile and local extensions:

```text
src/app/kitConfig.ts
src/app/appProfile.ts
src/app/routes/*
src/assets/*
```

The app should import Photon platform code from the Git dependency and pass its
profile/config into the platform shell.

## Why Not Subdirectory Git Dependencies

npm Git dependencies expect a package at the repository root. They do not give a
portable, registry-free way to install only `packages/core` from a monorepo
subdirectory.

If Photon grows into multiple packages, choose one of these shapes:

- Keep a root package that re-exports the supported public entrypoints.
- Split critical packages into separate Git repositories.
- Use Git submodules or subtree for source-level vendoring.

For the current goal, the root package approach is the simplest. It keeps the
release unit aligned with the Photon tag and avoids relying on npm registry
publication.

## App Upgrade Flow

Update the app dependency to the target Photon release:

```bash
npm install @quantum-box/photon@0.3.0
```

Then run the app's verification gates:

```bash
npm run type-check
npm test
npm run type-check:worker
```

For UI-facing changes, run the app locally and verify the main user flows in a
browser before cutting the app release.

## Release Contract

Every Photon release should include:

- A Git tag such as `v0.3.0`, which `release.yml` cuts from the version in
  `package.json` once CI is green on `main`, and which triggers the npm
  publish.
- A changelog that separates app-facing breaking changes from internals.
- Migration notes for `kitConfig`, environment variables, Worker bindings, and
  server migrations.
- Verification commands run against Photon itself.

Every consuming app should record:

- The Photon version or Git tag in `package.json` and `package-lock.json`.
- Any local app-profile changes needed for that tag.
- Verification commands run against the app.
