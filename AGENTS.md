# Repository Guidelines

## Project Structure & Module Organization

Photon is a React 19 + Vite client with Tauri and a Rust backend.

- `src/`: frontend app code. Routes live in `src/router.tsx`; shared state is under `src/contexts/`; Yjs sync helpers are in `src/lib/yjs/`.
- `src/app/kitConfig.ts`: project settings for branding, navigation, record defaults, storage, and sync.
- `src/components/chat/` and `src/components/files/`: chat and file preview features.
- `src/assets/`: static frontend assets.
- `src-tauri/`: Tauri desktop shell.
- `crates/`: the Rust Cargo workspace.
  - `photon-engine/`: the sync core — operations, records, CRDT projection, storage adapters, WASM kernel.
  - `photon-axum/`: Engine sync + Live relay as mountable axum routers. Migrations live in `crates/photon-axum/migrations/`.
  - `photon-server/`: thin runnable binaries (combined, engine-only, live-only) over `photon-axum`.
- `examples/rust-sync-server/`: reference Engine sync server, used as a test fixture.
- `tests/e2e/`: Playwright end-to-end tests.

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

Keep reusable shell code independent of project names. Put labels, defaults, persistence keys, and WebSocket paths in `src/app/kitConfig.ts`.

## Testing Guidelines

Use Vitest for focused unit tests in `src/**/*.{test,spec}.{ts,tsx}`. Use Playwright for browser flows in `tests/e2e/*.spec.ts`.

E2E tests should cover critical shell behavior: route navigation, record creation/editing, Kanban movement, chat streaming, file attachment, and persistence/sync behavior. Prefer role, label, and `data-testid` locators.

## Commit & Pull Request Guidelines

History uses concise conventional commits with Linear-style IDs, for example:

- `feat: PLT-348 implement record CRUD operations with Y.Doc integration`
- `feat: PLT-346 add dark mode and theme system with light/dark/system toggle`

For pull requests, include a summary, linked ticket or PLT ID, verification commands, and screenshots for UI changes. Call out migrations, Tauri changes, and setup changes.

## Security & Configuration Tips

Do not commit generated data such as `dist/`, `target/`, local SQLite files, Playwright reports, or secrets. Keep ports and API endpoints explicit so frontend, backend, mobile, and desktop clients share runtime assumptions.
