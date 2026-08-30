# Changelog

Photon ships as a Git tag, so a release is what an app gets when it moves its
dependency to the next tag. App-facing changes are separated from internals.

## Unreleased

### App-facing

- **A push the client did not hear the answer to no longer poisons its sync.**
  The authority stamps its own audit metadata — a request id and a receive
  timestamp — onto every operation before storing it, and then compared the
  stamped operation against the stamped one already on file to decide whether a
  push was a retry. The stamp differs on every request, so the idempotent
  replay promised in 0.3.0 never actually applied to a real client: any
  operation whose response was lost (a reload mid-push, a dropped connection, a
  timeout) came back as `500 operation id ... was reused with a different
  payload`, on every attempt, forever. Replay identity is now judged on what
  the client authored, with the authority's own key excluded.
- **A failed push no longer cancels the pull.** Both ran inside one cycle, so a
  client holding a single operation the server would not take stopped receiving
  everyone else's writes — with no symptom beyond a sync status nobody watches.
  Sending and receiving are now attempted independently; a push failure is
  still reported and still retried on the same backoff.

## 0.3.0

A minor bump, not a patch, and deliberately so: `^0.2.0` in a consuming app
would swallow a patch on a plain `npm update`, and this release carries an
Engine schema migration that runs on startup. Crossing to `0.3.0` makes the
consuming app widen its range on purpose, so the migration lands when someone
chose it. The Rust `StorageAdapter` trait also gained two required methods,
which breaks any out-of-tree adapter.

### App-facing

- **A client can now serve collections it did not know about when it was
  built.** `resolveCollection` is consulted once per collection the client
  encounters and its answer is cached, so an app whose data is partitioned per
  project, per board, or per repository no longer has to enumerate the
  partitions up front — which previously meant either a network round trip
  before the client existed, or rebuilding the client whenever the set changed.
  Neither survives an offline start. `collections` keeps working unchanged and
  wins for any name it declares.

- **More than one Engine instance can now serve one database.** The authority
  assigned each accepted operation's remote sequence from a counter in the
  server process, so two replicas over one database handed out the same
  sequence — or committed out of sequence order, which makes a concurrent pull
  advance its cursor past an uncommitted sequence and never see that operation
  again. Assignment, the operation write and the record projection now commit
  in one database transaction, serialized by a single-row lock. Running the
  Engine as several replicas, pods, or serverless invocations is safe.
- **Retrying a push no longer double-applies it.** An already-accepted
  operation replayed at the authority returns its original sequence and the
  committed projection instead of re-projecting. `Increment` is not idempotent,
  so a retried push previously risked counting twice.
- **Reusing an operation id with a different payload is rejected.** The id is
  the idempotency key, so it may not be repointed at other content.
- **Engine schema migration v2** adds `photon_engine_sync_state`. It applies on
  startup and seeds past the sequences the op-log already used, so an existing
  database keeps its numbering. No app change required.
- **A `rest-backed` collection can now create records.** The adapter guessed
  create-or-update from the local projection, but the client writes the
  optimistic value in before the push runs, so a first write always looked like
  an edit and went out as an update. Against a real backend that is a 404,
  which is a rejection, so the new record was silently dropped. `RestResource`
  gains an optional `upsert(recordId, value)` for backends with PUT-style
  semantics; supply it and `upsert` operations go through it instead of the
  guess. Resources without one are unchanged, and still depend on the backend
  tolerating an update to an id it has never seen.

### Internal

- `StorageAdapter` gains `append_authoritative_operation` and
  `next_remote_sequence`. Custom adapters must implement both.
- `PhotonEngine::accept_authoritative_operation` is the authority-side
  counterpart to `apply_remote_operation`, which still takes a caller-supplied
  sequence and stays the right call when replaying a pull.
- `AppState::engine_next_seq` and `AppState::engine_push_lock` are gone.
- The storage contract test covers acceptance for every adapter, and a new
  SQLite test drives six independent adapters over one database file to assert
  the sequences come out as 1..6 with every increment landing exactly once.

## 0.2.0

### App-facing

- **Photon is published to the npm registry as `@quantum-box/photon`.**
  `npm install @quantum-box/photon` is now the recommended route, and the
  published tarball ships a prebuilt WASM kernel — installing it needs no Rust
  toolchain. Git tag installs keep working unchanged, and still build the
  kernel on install. MIT license declared, `LICENSE` added.
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

Installing from a Git tag still requires a Rust toolchain with the
`wasm32-unknown-unknown` target and wasm-pack on every machine that runs
`npm install` or `npm ci`, because `prepare` builds the WASM kernel. Registry
installs do not. See [docs/release-following.md](docs/release-following.md).

### Internal

- `release.yml` publishes to npm from the release tag, guarded so a re-run
  cannot try to republish an existing version. It needs the `NPM_TOKEN` secret.
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
