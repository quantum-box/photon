# Photon

AI × リアルタイム思考速度インターフェース基盤。Tachyon プラットフォーム全体を操作する統合 UI。

## コンセプト

- **究極の楽観 UI**: 操作は即座に反映、バックグラウンドで同期
- **リアルタイム AI**: 操作コンテキストを AI が理解し提案・自動処理
- **自然言語オペレーション**: テーブル操作やフィルタを自然言語で実行
- **Local-first**: オフライン対応、復帰時自動同期 (CRDT ベース)

## 技術スタック

| レイヤー | 採用技術 |
|---|---|
| UI フレームワーク | Vite + React + TypeScript |
| デスクトップ | Tauri v2 (Web / デスクトップ両対応) |
| ルーティング | TanStack Router |
| テーブル | TanStack Table |
| スタイル | Tailwind CSS + Radix UI |
| テスト | Vitest |

## 現在実装済みの機能

- **Issues (テーブルビュー)**: issue 一覧・ソート・ステータスフィルタ・インライン編集
- **Board (カンバンビュー)**: ドラッグ&ドロップでステータス変更
- **Detail パネル**: issue 詳細・編集・削除
- **Chat**: AI チャットビュー
- **Create Issue モーダル**: 新規 issue 作成

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
