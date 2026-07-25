# Photon

AI × リアルタイム思考速度インターフェース基盤。Tachyon プラットフォーム全体を操作する統合 UI。

## コンセプト

- **究極の楽観 UI**: 操作は即座に反映、バックグラウンドで同期
- **リアルタイム AI**: 操作コンテキストを AI が理解し提案・自動処理
- **自然言語オペレーション**: テーブル操作やフィルタを自然言語で実行
- **Local-first**: オフライン対応、復帰時自動同期 (CRDT ベース)

## Sync Model

Photon の同期体験は **Photon Engine** と **Photon Live** の2層で整理する。

- **Photon Engine**: 通信が不安定でも作業内容を失わない durable data mutation path。オフライン中も作成・編集・削除をローカルに保存し、オンライン復帰後に push/pull sync で追いつく。
- **Photon Live**: 共同編集の手触りを作る realtime collaborative UX path。他の人の編集、presence、awareness、同じ画面を一緒に触っている感覚を扱う。オフライン中は transport/presence を止め、ローカル編集は続け、再接続時に local state を送る。
- **REST/RPC API**: bootstrap、auth、special commands、sync endpoint を提供する外側の API 層。

ざっくり言うと、Photon Engine は「消えない安心感」、Photon Live は「一緒に操作している感じ」を担当する。

## 技術スタック

| レイヤー | 採用技術 |
|---|---|
| UI フレームワーク | Vite + React + TypeScript |
| デスクトップ | Tauri v2 (Web / デスクトップ両対応) |
| ルーティング | TanStack Router |
| テーブル | TanStack Table |
| スタイル | Tailwind CSS + Radix UI |
| Photon Engine | Rust crate (`crates/photon-engine`) |
| Photon Live | Yjs + IndexedDB + WebSocket / Durable Object room |
| アプリ API | Rust axum + SQLite (`crates/photon-axum`) |
| テスト | Vitest |

## 現在実装済みの機能

- **Records (テーブルビュー)**: record 一覧・ソート・ステータスフィルタ・インライン編集
- **Board (カンバンビュー)**: ドラッグ&ドロップでステータス変更
- **Detail パネル**: record 詳細・編集・削除
- **Chat**: AI チャットビュー
- **Create Record モーダル**: 新規 record 作成

## ローカル開発

```bash
# 依存インストール
npm install

# Web 版 dev サーバー起動
npm run dev

# デスクトップ版 (Tauri) 起動
npm run tauri:dev

# 型チェック
npm run type-check

# テスト
npm run test
```

## txcloud auth 接続

Photon can require txcloud auth email/password sign-in before the shell loads. Enable it with env vars instead of committing credentials:

```bash
VITE_PHOTON_API_BASE_URL=https://api.n1.tachy.one
VITE_PHOTON_AUTH_ENABLED=true
VITE_PHOTON_AUTH_TRANSPORT=rest
VITE_PHOTON_AUTH_PASSWORD_PATH=/auth/v1beta/sign-in-with-password
VITE_PHOTON_AUTH_TENANT_ID=tn_01hjjn348rn3t49zz6hvmfq67p
VITE_PHOTON_OPERATOR_ID=<operator-id-if-required>
npm run dev -- --host 127.0.0.1
```

`VITE_PHOTON_AUTH_PASSWORD_PATH` defaults to `/auth/v1beta/sign-in-with-password`. The acquired access token is stored in localStorage under `VITE_PHOTON_AUTH_TOKEN_STORAGE_KEY` or the default Photon namespaced key, then attached as `Authorization: Bearer <token>` to Photon API requests.

PLT-1038 enforces normalized global auth emails. Photon trims and ASCII-lowercases the submitted email and treats duplicate/conflict responses as sign-in errors instead of assuming a second user can be created.

## ビルド

```bash
# Web ビルド
npm run build

# デスクトップビルド
npm run tauri:build
```

## リポジトリ

- GitHub: https://github.com/quantum-box/tachyon-ui (public)
- Linear プロジェクト: photon
