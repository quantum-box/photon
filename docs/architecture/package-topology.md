# Package Topology

## 依存グラフ

```
                    @quantum-box/photon-core
                     (React も PGlite も Vite も知らない)
                    /          |            \
       photon-react     photon-store-pglite   photon-wasm
       (peer: react)     (dep: PGlite)        (dep: crates/photon-engine/pkg)
                    \          |            /
                     examples/playground

photon-edge-worker  ← 独立。Cloudflare Worker のみ
```

Rust:

```
photon-engine  ←  photon-axum  ←  photon-server
      ↑
      └── examples/rust-sync-server
      └── examples/playground/src-tauri  (workspace 外)
```

## 不変条件

**`packages/core` は React / PGlite / Vite を import しない。**

これは規約ではなく、依存グラフで機械的に強制する。`packages/core/package.json` の `dependencies` は空であり、そこに React を足さない限り import できない。`kitConfig` 型の漏れが再発しないための唯一の手段がこれ。

**`packages/` に UI を置かない。**

エンジン面はフレームワーク非依存を保つ。React は playground と `packages/react` にだけ存在する。

**SDK はモジュールスコープで環境グローバルを読まない。**

`import.meta.env` / `window.location` / `localStorage` / `navigator` をモジュール評価時に読まない。`navigator.onLine` だけは、注入可能な監視の背後で許可する。ブラウザ・Node・Web Worker・Vitest・Tauri でそのまま動くことが条件。

環境依存の判断（IndexedDB があるか、テスト中か）はアプリの責務であり、playground 側で行う。

## 配布形態

単一パッケージ `@quantum-box/photon` + subpath exports。

| Subpath | ソース |
|---|---|
| `.` | `packages/core/dist/index.js` |
| `./react` | `packages/react/dist/index.js` |
| `./rest` | `packages/core/dist/rest/index.js` |
| `./store-pglite` | `packages/store-pglite/dist/index.js` |
| `./wasm` | `packages/wasm/dist/index.js` |
| `./worker` | `packages/edge-worker/dist/index.js` |

内部パッケージは全て `private: true`。個別公開しない理由は [release-following.md](../release-following.md) の通り、git インストールがサブディレクトリを取得できないため。レジストリ導入とセットでない限り複数パッケージ公開は成立しない。

## WASM 生成物

`crates/photon-engine/pkg/` は生成物であり、**コミットしない**。

かつてここに手書きのスタブ（呼ぶと throw する）がコミットされており、同じパスに `npm run build` が実物を書き出していた。結果として実ビルドのたびに作業ツリーが汚れ、かつ全ユニットテストが「呼ぶと throw するスタブ」に対して走っていた。

いまは CI がフロントエンドのジョブより先に `npm run engine:wasm` を実行する。ローカルでも初回に一度必要。

## テスト境界

| 層 | 何を担保するか |
|---|---|
| `packages/core` の vitest | 投影・クエリ・ミューテーション・REST マッピング（fake kernel + in-memory store で高速・決定的） |
| `examples/playground` の vitest | 実 WASM カーネル + 実 PGlite での往復 |
| `cargo test --workspace` | Rust 側の projection・storage adapter・sync |
| Playwright | ブラウザ実挙動 |

`packages/core` の vitest は `environment: 'node'` で走る。jsdom が要るようになったら、それはエンジンにブラウザ依存が入った合図。
