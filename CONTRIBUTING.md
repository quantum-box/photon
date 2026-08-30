# Contributing

Thanks for taking the time to improve Photon.

Photon is a local-first sync engine: durable offline writes, instant UI, and
convergent reconciliation. Small, focused changes are easiest to review — bug
fixes, documentation improvements, examples, and tests are all welcome.

## Development Setup

Requirements:

- Node.js 22
- Rust (stable) with the `wasm32-unknown-unknown` target for the engine build
- `wasm-pack` (invoked through `npx`)

```bash
git clone https://github.com/quantum-box/photon.git
cd photon
npm ci
npm run engine:wasm
```

The repository is an npm workspace plus a Cargo workspace. The TypeScript
packages live under `packages/`, the Rust crates under `crates/`, and the
playground application under `examples/playground/`.

Common commands:

```bash
npm run dev            # start the playground
npm run server         # start the Rust backend
npm run build          # build the published packages and the playground
```

## Before Opening a PR

Run the checks that match CI:

```bash
npm run lint
npm run type-check
npm run type-check:worker
npm test
npm run build

cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
```

If your change touches the playground UI or the sync flows, also run:

```bash
npm run test-storybook
npm run test:e2e
```

If your change touches the published package surface, also run:

```bash
npm run smoke:exports
```

## Pull Requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages and PR titles.
- Keep one intent per pull request.
- Describe what behavior changes, and how you verified it.
- Add or update tests for behavior changes. Sync and offline behavior in
  particular should be covered by a test that fails without the change.
- Do not commit secrets, credentials, or environment-specific values.

## Reporting Bugs and Requesting Features

Open a GitHub issue with the smallest reproduction you can produce. For sync
issues, include the platform, whether the client was offline, and what state you
expected after reconnecting.

For security issues, do **not** open a public issue. Follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing to Photon, you agree that your contributions are licensed under
the [MIT License](LICENSE).
