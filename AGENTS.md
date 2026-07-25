# Repository Guidelines

## Project Structure & Module Organization

Photon is a local-first sync engine. The engine is the product; the React app under `examples/playground/` is a dogfooding harness.

- `packages/`: the published TypeScript surface. `edge-worker/` is the Cloudflare Worker (Engine proxy + Live Durable Object relay).
- `examples/playground/`: the dogfooding React app. Routes in `src/router.tsx`, shared state in `src/contexts/`, Yjs helpers in `src/lib/yjs/`, app settings in `src/app/kitConfig.ts`.
- `examples/playground/src-tauri/`: Tauri desktop shell (outside the Cargo workspace).
- `crates/`: the Rust Cargo workspace.
  - `photon-engine/`: the sync core — operations, records, CRDT projection, storage adapters, WASM kernel.
  - `photon-axum/`: Engine sync + Live relay as mountable axum routers. Migrations live in `crates/photon-axum/migrations/`.
  - `photon-server/`: thin runnable binaries (combined, engine-only, live-only) over `photon-axum`.
- `examples/rust-sync-server/`: reference Engine sync server, used as a test fixture.
- `examples/playground/tests/e2e/`: Playwright end-to-end tests.

## Build, Test, and Development Commands

- `npm install`: install frontend and test dependencies.
- `npm run dev -- --host 127.0.0.1`: start the Vite frontend on port `5173`.
- `cargo run --bin photon-server`: start the backend on port `3001`.
- `npm run build`: type-check and build the frontend.
- `npm run type-check`: run TypeScript checks without emitting files.
- `npm test`: run Vitest unit tests.
- `npm run test:e2e`: run Playwright E2E tests.
- `cargo test --workspace`: run backend Rust tests.
- `npm run tauri:dev`: run the desktop app during development.

## Coding Style & Naming Conventions

Use TypeScript, React function components, and hooks. Keep components in PascalCase files such as `CreateRecordModal.tsx`; hooks use `useSomething.ts`.

ESLint is configured in `eslint.config.js`. Use two-space indentation, single quotes, and existing Tailwind utility patterns. Add `data-testid` only for stable user-facing flows that need E2E coverage.

Keep engine code free of app naming. Labels, defaults, persistence keys, and WebSocket paths belong in `examples/playground/src/app/kitConfig.ts`, never in `packages/`.

## Testing Guidelines

Use Vitest for focused unit tests next to the code they cover. Use Playwright for browser flows in `examples/playground/tests/e2e/*.spec.ts`.

Do not put UI in `packages/`. The engine surface stays framework-agnostic; React lives in the playground and, later, in the React adapter package.

E2E tests should cover critical shell behavior: route navigation, record creation/editing, Kanban movement, chat streaming, file attachment, and persistence/sync behavior. Prefer role, label, and `data-testid` locators.

## Commit & Pull Request Guidelines

History uses concise conventional commits with Linear-style IDs, for example:

- `feat: PLT-348 implement record CRUD operations with Y.Doc integration`
- `feat: PLT-346 add dark mode and theme system with light/dark/system toggle`

For pull requests, include a summary, linked ticket or PLT ID, verification commands, and screenshots for UI changes. Call out migrations, Tauri changes, and setup changes.

## Security & Configuration Tips

Do not commit generated data such as `dist/`, `target/`, local SQLite files, Playwright reports, or secrets. Keep ports and API endpoints explicit so frontend, backend, mobile, and desktop clients share runtime assumptions.
