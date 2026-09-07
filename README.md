# Photon

ローカルファーストな同期エンジン。**オフラインでも書き込みが消えず、操作が即座に画面に出て、復帰時に収束する** — これだけを提供する。

UI は持たない。データに集中している。設計思想は [docs/architecture/design-principles.md](docs/architecture/design-principles.md) を参照。

```ts
import { createPhotonClient, createEngineTransport } from '@quantum-box/photon'
import { createPGliteStore } from '@quantum-box/photon/store-pglite'
import { loadPhotonKernel } from '@quantum-box/photon/wasm'

const photon = await createPhotonClient({
  scope: 'workspace:acme:roadmap',
  actorId: `${deviceId}:${userId}`,
  storage: await createPGliteStore({ dataDir: 'idb://photon-acme' }),
  kernel: await loadPhotonKernel(),
  transport: createEngineTransport({ baseUrl: 'https://api.example.com' }),
})
```

```tsx
import { useLiveQuery, useMutation } from '@quantum-box/photon/react'

function Records() {
  const { data: records } = useLiveQuery<Issue>({
    collection: 'records',
    where: { status: { ne: 'archived' } },
    orderBy: [{ field: 'updatedAt', direction: 'desc' }],
  })

  const setStatus = useMutation((client, { id, status }: Args) =>
    client.patch<Issue>('records', id, { status }),
  )

  return records.map((record) => (
    <Row
      key={record.key.record_id}
      record={record.value}
      dimmed={record.pending}          // サーバ未 ack
      onChange={(status) => setStatus.mutate({ id: record.key.record_id, status })}
    />
  ))
}
```

`setStatus.mutate` は即座に返る。**ブラウザがペイントする前に**この行は新しい値で再レンダリングされ、`record.pending` が ack まで `true`、失敗すれば逆操作で自動ロールバックする。

## 何を保証するか

| 保証 | 意味 |
|---|---|
| **消えない** | 書き込みは操作ログとしてローカルに耐久化される。オフラインでもリロードでも残る |
| **即座に出る** | ミューテーションは同期的に投影へ反映され、同じ tick で購読側に届く |
| **収束する** | 復帰時に push/pull し、フィールド単位の CRDT マージで解決する |
| **正直に壊れる** | reject は逆操作でロールバックし、conflict は行として残る。黙って握り潰さない |

React の `useOptimistic` より強い。楽観値はアンマウントを跨いで残り、同じレコードを表示する全コンポーネントで共有され、ナビゲーションを越える。

## 段階的に入れられる

エンジンは HTTP を呼ばない。`SyncTransport` を定義するだけで、実装は差し替えられる。**サーバを移行し終わるまで使えない、という状態を作らない。**

```ts
// ① 導入時 — バックエンド変更ゼロ
collections: { issues: { mode: 'passthrough', resource: issues } }

// ② オフライン対応が欲しくなったら
collections: { issues: { mode: 'rest-backed', resource: issues } }

// ③ サーバが engine プロトコルを喋るようになったら
collections: { issues: { mode: 'engine-native' } }
```

**3 段階すべてでコンポーネントコードは無変更。** 変わるのはこの 1 行だけ。

`rest-backed` は既存の REST API に対して 5 行のアダプタを書くだけで、オフライン編集キュー・楽観 UI・失敗ロールバック・conflict 表示が入る。既存の認証・インターセプタ・リトライはそのまま効く。

ただし素の REST は CRDT マージを表現できない。`increment` / `setAdd` / `setRemove` はローカルで解決して patch として送るので、REST 境界では last-write-wins になる。本当のマージが要るコレクションは `engine-native` に上げる。

## Photon Engine と Photon Live

同期体験は 2 層に分かれている。

- **Photon Engine**: 構造化データの唯一の権威。operation log として耐久化し、push/pull で収束させる。「消えない安心感」を担当する。
- **Photon Live**: Yjs によるリッチテキストの共同編集と presence。「一緒に操作している感じ」を担当する。構造化データは扱わない。

## 入れる

```bash
npm install @quantum-box/photon
```

tarball には WASM カーネルがビルド済みで入っているので、**入れる側に Rust toolchain は要らない**。

`react` は optional peer dependency で、`@quantum-box/photon/react` を使うアプリが自分で持つ。PGlite は依存として同梱される。

レジストリを経由したくない場合は Git タグからも入る。こちらは install 時に `prepare` が WASM をビルドするので、**入れる側の環境に Rust toolchain（`wasm32-unknown-unknown` target）と wasm-pack が要る**：

```bash
npm install git+ssh://git@github.com/quantum-box/photon.git#v0.3.0
```

詳細は [docs/release-following.md](docs/release-following.md)。

## パッケージ構成

単一パッケージ + subpath exports。

| Import | 中身 |
|---|---|
| `@quantum-box/photon` | フレームワーク非依存のコア。React も PGlite も Vite も import しない |
| `@quantum-box/photon/react` | `useLiveQuery` / `useMutation` / `useSyncStatus` などの hooks |
| `@quantum-box/photon/rest` | 既存 REST API 用のトランスポート |
| `@quantum-box/photon/store-pglite` | PGlite 永続化アダプタ |
| `@quantum-box/photon/wasm` | WASM カーネルのローダー |
| `@quantum-box/photon/worker` | Cloudflare Worker（Engine プロキシ + Live リレー） |

Rust 側は Cargo workspace:

| Crate | 役割 |
|---|---|
| `photon-engine` | 同期コア。operation / record / CRDT projection / storage adapter / WASM カーネル |
| `photon-axum` | Engine sync と Live リレーを axum router として提供。既存サービスに `.merge()` できる |
| `photon-server` | mode / DB / port を解決するだけの実行バイナリ |

```rust
let app = Router::new()
    .merge(photon_axum::engine_router(state.clone()))  // /api/engine/{push,pull,debug}
    .merge(photon_axum::live_router(state))            // /ws
    .route("/api/my-own-thing", get(my_handler));
```

## マルチタブ

PGlite は data directory ごとに単一接続で、同一 origin のタブは同じ IndexedDB を見る。
各タブが自分で開くと壊れるので、**1 つのタブだけが実体を開き、残りはそこへ転送する**。
オーナーのタブが閉じたら、次のタブが昇格して自分で開き直す。

```ts
import { createSharedLocalStore } from '@quantum-box/photon'
import { createPGliteStore } from '@quantum-box/photon/store-pglite'

const storage = await createSharedLocalStore({
  key: 'idb://photon-acme',
  open: () => createPGliteStore({ dataDir: 'idb://photon-acme' }),
})
```

`LocalStore` が約 10 個の冪等なメソッドしか持たないので、「別コンテキストへ転送する」実装は小さく、
下の transport は差し替えられる。いまは BroadcastChannel + Web Locks（Android WebView を含む
全ターゲットで動く）で、SharedWorker や Tauri の Rust 側は `channel` / `elect` を差し替えるだけで載る。

他タブの書き込みは `LocalStore.subscribe` 経由でこのタブの projection に取り込まれるので、
サーバへの往復を待たずに画面が揃う。

単一タブしか無いことが分かっているホストは、これを使わず `createPGliteStore` を直接渡してよい。
2 タブ目を黙って壊すよりはっきり落としたいだけなら、`createPGliteStore({ exclusiveLock: true })` で
2 タブ目が `PGliteStoreLockedError` になる。

何がどう壊れていて、なぜこの形にしたのかは
[docs/architecture/multi-tab-local-store.html](docs/architecture/multi-tab-local-store.html) に図で置いてある。

## 設計上の約束

- **カーネルは同期的で、ストレージを持たない。** operation 構築・CRDT 投影・時計の因果関係だけを担い、I/O をしない。だから async の世界が 1 つで済み、`!Send` なストレージ trait をネイティブエンジンに伝播させずに済む。
- **JS フォールバックは無い。** WASM のロード失敗は hard error。かつて「ロード失敗時は shallow merge」というフォールバックがあり、fetch が成功したかどうかでマージ意味論が静かに変わっていた。
- **時計は常に引数。** `Operation::at` / `HybridTimestamp::at` — テストが決定的になり、`SystemTime::now()` が panic する wasm32 でも動く。
- **ID はクライアントが決める（uuid v7）。** temp-ID → server-ID の載せ替えが設計から消え、作成直後の画面遷移がオフラインでも 404 にならない。
- **`patch` は変更フィールドだけを取る。** レコード全体を渡すとフィールド単位の HLC マージが壊れる。
- **ロールバックは逆操作。** accepted な操作だけから再射影する。「前の値を復元」だと、その間に着地した並行リモート編集を踏み潰す。
- **SDK はモジュールスコープで `window` / `localStorage` / `import.meta.env` を読まない。** ブラウザ・Node・Web Worker・Vitest・Tauri でそのまま動く。

## リポジトリ構成

```
crates/           Rust workspace（engine / axum / server）
packages/         TypeScript の公開面（core / react / store-pglite / wasm / edge-worker）
examples/
  playground/     dogfooding 用 React アプリ。製品ではなくリグレッション面
  rust-sync-server/  Engine 同期サーバの参照実装
docs/
```

## 開発

```bash
npm install
npm run engine:wasm          # WASM カーネルを生成（初回必須）
npm run server               # Rust サーバを :3001 で起動
npm run dev                  # playground を :5173 で起動
```

| コマンド | 内容 |
|---|---|
| `npm run type-check` | 全 workspace の型チェック |
| `npm test` | 全 workspace のユニットテスト |
| `npm run lint` | ESLint |
| `cargo test --workspace` | Rust テスト |
| `npm run test:e2e` | Playwright E2E |
| `npm run tauri:dev` | playground のデスクトップ版 |

ローカル同期ラボ（Docker + Edge Worker + Web の三層）は `mise run sync:infra` / `sync:edge` / `sync:web` / `sync:smoke`。

## playground の auth 設定

playground は txcloud auth のサインインを要求できる。エンジン自体は auth クライアントを持たず、`headers` フックだけを受け取る。

```bash
VITE_PHOTON_API_BASE_URL=https://api.n1.tachy.one
VITE_PHOTON_AUTH_ENABLED=true
VITE_PHOTON_AUTH_TRANSPORT=rest
VITE_PHOTON_AUTH_PASSWORD_PATH=/auth/v1beta/sign-in-with-password
VITE_PHOTON_AUTH_TENANT_ID=tn_01hjjn348rn3t49zz6hvmfq67p
npm run dev -- --host 127.0.0.1
```

取得したアクセストークンは localStorage に保存され、`Authorization: Bearer <token>` として付与される。

デモデータの投入は `seedPlaygroundData()` として明示的に行われる（dev のみ、`VITE_PHOTON_SEED_DEMO_DATA=false` で無効化）。読み取りパスがレコードを捏造することはない。

## リンク

- GitHub: https://github.com/quantum-box/photon
- Linear プロジェクト: photon
- 設計判断: [docs/architecture/decisions/](docs/architecture/decisions/)

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。

- コントリビューション方法: [CONTRIBUTING.md](CONTRIBUTING.md)
- 脆弱性の報告: [SECURITY.md](SECURITY.md)
- 行動規範: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

### Scoped sync and atomic batches

See [scoped sync](docs/scoped-sync.md) for filtered subscriptions, bounded local reads, cache release, stable REST operation context and opt-in atomic writes.
