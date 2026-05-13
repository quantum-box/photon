# Photon

Photon is a React 19 + Vite + Tauri app with Yjs-backed issue sync.

## Development

Run the default local Rust sync backend:

```bash
cd packages/server && cargo run
npm run dev -- --host 127.0.0.1
```

Run the Cloudflare Workers + Durable Objects sync backend locally:

```bash
npm run worker:dev
npm run dev:cf-sync -- --host 127.0.0.1
```

See [Cloudflare Sync Backend](docs/cloudflare-sync.md) for the Durable Objects
runtime model and deployment notes.

## Verification

Run the release gates locally from the repository root unless a command includes
its own directory change:

```bash
npm run type-check
npm test
npm run build
npm run type-check:worker
npm run test:e2e
cd packages/server && cargo test
```

`npm run test:e2e` starts the Rust server and Vite dev server through
Playwright. For manual debugging, start the same services directly:

```bash
cd packages/server && cargo run
npm run dev -- --host 127.0.0.1
```

Worker sync checks use the Cloudflare local runtime:

```bash
npm run worker:dev
npm run dev:cf-sync -- --host 127.0.0.1
```

See [Photon v0.2 Release Checklist](docs/photon-v0.2-release-checklist.md) for
the workspace-flow gates and residual release risks.

## Server Deploy

The Rust application server can be built as a container and deployed to Cloud
Run. See [Photon Server Deploy](docs/server-deploy.md) for the Dockerfile,
GitHub Actions workflow, required repository variables, and frontend runtime
environment wiring.

## App Builds

Photon also builds as a Tauri desktop and mobile app. See
[App Platform Builds](docs/app-platforms.md) for desktop release, Android, and
iOS commands.

## Original Vite Notes

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
