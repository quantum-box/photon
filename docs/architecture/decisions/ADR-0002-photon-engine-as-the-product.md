# ADR-0002: Photon Engine as the Product

- Status: Accepted
- Date: 2026-07-25
- Supersedes: [ADR-0001](ADR-0001-sync-responsibility-boundaries.md)

## Context

このリポジトリは「sync engine を内包した React ワークスペースアプリ」になっていた。`src/` の 19,345 行のうち components が 11,175 行、`router.tsx` に 1,357 行のページコンポーネントがインラインで入っている一方、製品の核であるべき `photonEngine/client.ts`（748 行）は package の exports に含まれてすらいなかった。

さらに構造化データが Engine（PGlite op-log）と Yjs の 2 箇所で独立管理される split-brain 状態にあった。React は Yjs から描画し、Engine は書き込まれるだけで読まれない。Engine の pending operation は debug ダッシュボードのボタンでしか flush されなかった。

外部から `@quantum-box/photon` を import しているリポジトリは 0 件だった。

## Decision

### 1. エンジンが製品であり、UI はリポジトリを出る

React アプリは `examples/playground/` に降格する。dogfooding とリグレッション面としては維持するが、製品ではない。UI は props 専用の別ライブラリ `@tachyon-sdk/native-ui` が担う。

Photon が売るのは「オフラインでも消えず、操作が即座に反映され、復帰時に収束する」ことそのもの。native-ui が design-system として「アプリ側責務」と明記している楽観 UI の実装を、Photon がストア層で提供する。

### 2. 構造化データは operation log に一本化する

Engine の op-log を構造化データの単一権威とする。Yjs は BlockNote のリッチテキストと presence に限定する。

ADR-0001 が定めた Engine / Live の責務分割自体は今も正しい。変わるのは 2 点:

- 構造化データが Yjs に二重書きされなくなる
- 「アプリサーバが domain data を所有する」書き込みパス（ADR-0001 の手順 1–6）が op-log に置き換わる

ADR-0001 の follow-up（PLT-1180, 1183, 1186, 1188）は「実装により解決」ではなく「削除により解決」となる。

### 3. カーネルは同期的で、ストレージを持たない

Rust の `PhotonKernel` は operation 構築・CRDT 投影・replay・時計の因果関係を担い、ストレージと I/O を持たない。エンジンループは TS 側に置く。

**エンジン全体を WASM に入れない理由:**

- `StorageAdapter` は `Send + Sync` の `#[async_trait]`。JS バックの adapter は `JsFuture` を await するので `!Send` になり、trait を `?Send` 版に分岐させ、既存 adapter と `PhotonEngine<A>` 全体に伝播する。axum 側は tokio のため `Send` が必要 → 2 つの async 世界を永久に抱える。
- ミューテーション 1 回あたり WASM↔JS 境界を 3 回以上越え、毎回 `Record` 全体を serde 通過させる。
- OPFS-SQLite 案（`sqlx` は wasm32 でビルド不可）は VFS 自作 + 専用 Worker 必須で、結局 postMessage プロトコルになる。

**時刻は全て引数化する。** `SystemTime::now()` は `wasm32-unknown-unknown` で panic する。副産物としてテストが決定的になる。

### 4. JS フォールバックを持たない

`applyClientOperationInPgliteForTests` が「WASM ロード失敗時の本番フォールバック」として動いており、その実体は CRDT ではない単純な shallow merge だった。**fetch が成功したかどうかでマージ意味論が静かに変わる**のが現状最悪の性質だったので、WASM 初期化失敗は hard fail にする。

### 5. パッケージトポロジ: 単一 artifact + subpath exports

`@quantum-box/photon` 1 パッケージ + subpath exports で配布する。内部は npm workspaces で厳格分離し、`packages/core/package.json` の依存グラフに React が存在しないことで境界を機械的に強制する。

複数パッケージを個別公開しない理由は `docs/release-following.md` の通り: git インストールはサブディレクトリを取得できないため、レジストリ導入とセットでない限り成立しない。

### 6. Cargo workspace

Rust を `crates/` に統一し、単一 `Cargo.lock` にする。`photon-axum`（ライブラリ）と `photon-server`（バイナリ）を分割し、既存 axum サービスに `.merge()` できるようにする。

`examples/playground/src-tauri` は workspace から除外する。iOS/Android ビルドの `target/` 衝突と MSRV 結合を避けるため。

### 7. 段階移行を設計に組み込む

エンジンは HTTP を呼ばず `SyncTransport` を定義するだけにする。collection 単位で 3 モードを持つ:

| モード | ローカル耐久 | オフラインキュー | マージ意味論 | サーバ要件 |
|---|---|---|---|---|
| `engine-native` | ○ op-log | ○ | フィールド単位 CRDT | push/pull プロトコル |
| `rest-backed` | ○ op-log | ○ | REST 境界で LWW | 普通の REST |
| `passthrough` | ✗ メモリのみ | ✗ | LWW | 普通の REST |

**コンポーネント側のコードは 3 モードで完全に同一。** だから collection 単位でその場アップグレードできる。「サーバを移行し終わるまで使えない」という状態を一度も作らないことが、採用の実際的な条件だと判断した。

## Consequences

**得られるもの**

- 外部アプリが `@quantum-box/photon/react` をバックエンド変更ゼロで試せる
- 楽観 UI・ロールバック・conflict がストア層で 1 回だけ実装される
- Rust / TS / WASM で projection 実装が 1 つに保たれる（適合性テストで担保）
- エンジンのテストが UI から独立する

**失うもの / 引き受けるリスク**

- `rest-backed` は REST 境界で LWW になる。長時間オフラインだったクライアントが復帰したときに他者の編集を静かに踏み潰しうる。バックエンドが `If-Match` / version を持つなら 412 → `Conflict` に載せられるが、持たないなら並行編集は保護されない。
- WASM 必須化により、ロードできない環境ではエンジンが起動しない。これは意図した挙動（静かに間違うより落ちる）だが、モバイル Safari / WKWebView のコールドスタートは実測が必要。
- PGlite は単一接続。1 コンテキストだけが実体を開き、他は `createSharedLocalStore` 経由で転送する（Web Locks で選出、オーナーが閉じたら次が昇格）。`LocalStore` が冪等な約 10 メソッドに絞られていることがこの転送を成立させている。同期ループは各コンテキストで走ったままなので、タブ数だけ pull が出る。
- Yjs の構造化データ配列を削除する時点で、既存ユーザーの IndexedDB `workspace:*:records` Y.Doc は孤児化する。playground には「ローカルキャッシュリセット」が要る。

## 関連ファイル

- `crates/photon-engine/src/wasm.rs` — カーネル面
- `crates/photon-engine/src/types.rs` — 時刻引数化
- `packages/core/src/shared/` — マルチタブ共有ストア（選出・転送・昇格）
- `docs/architecture/multi-tab-local-store.html` — マルチタブの破損と解決の図解
- `packages/core/src/client.ts` — ミューテーションパスと投影
- `packages/core/src/sync/controller.ts` — 同期ループ
- `packages/core/src/rest/index.ts` — REST 共存モード
- `packages/react/src/index.tsx` — React バインディング
