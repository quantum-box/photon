# Changelog

Photon ships as a Git tag, so a release is what an app gets when it moves its
dependency to the next tag. App-facing changes are separated from internals.

## 0.2.0

### App-facing

- **Fixed: the public entrypoints resolve from an installed copy.**
  `@quantum-box/photon/react` and `@quantum-box/photon/wasm` failed with
  `Cannot find package '@quantum-box/photon-core'` in any consuming app, and
  the emitted `.d.ts` of `@quantum-box/photon/store-pglite` carried the same
  unresolvable specifier, so types broke too. Only the root entrypoint and
  `/rest` worked. The README's own wiring now runs from an installed copy.
- **`@electric-sql/pglite` ships as a Photon dependency.** Apps that installed
  it explicitly to make `/store-pglite` resolve can drop that line; keeping it
  is harmless as long as the version stays compatible.
- **`react` is declared as an optional peer dependency** (`^18 || ^19`). Apps
  using `/react` already satisfy it; core-only consumers are not forced to
  install React.
- **Installing is lighter.** `prepare` now builds the published packages only,
  not the playground, so a Git install no longer runs a Vite app build.

No code changes are required in consuming apps. No `kitConfig`, environment
variable, Worker binding, or server migration changes.

Installing still requires a Rust toolchain with the `wasm32-unknown-unknown`
target and wasm-pack on every machine that runs `npm install` or `npm ci`,
because `prepare` builds the WASM kernel. See
[docs/release-following.md](docs/release-following.md).

### Internal

- `scripts/rewrite-internal-imports.mjs` rewrites workspace specifiers in
  `dist` to relative paths after the build. Deliberately not a bundle: a copy
  of the core per entrypoint would mean two `KernelUnavailableError` classes
  and two module-level caches.
- `npm run smoke:exports` packs the tarball, installs it into a throwaway app,
  and imports, runs, and type-checks every entrypoint. It replaces the inline
  script in CI's package-contract job, which only type-checked with
  `skipLibCheck` — that skips declaration files, so it saw neither the broken
  `.d.ts` specifier nor the runtime failure. The playground imports the
  workspace names, so it cannot catch a broken public entrypoint either.

## 0.1.0

First tagged release.
