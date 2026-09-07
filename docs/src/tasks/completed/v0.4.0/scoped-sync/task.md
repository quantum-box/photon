# Photon同期機能の拡張

ユーザー依頼: 部分同期、オンデマンドロード、同期範囲外データ回収、REST操作context、atomic batchをすべて実装する。

設計: [design.md](design.md)

## 対象

packages/core、packages/store-pglite、shared-store、crates/photon-engine、crates/photon-axum、protocol tests。

## 進捗

- 最新main 81e25a2からfeature/scoped-sync-atomic-batchesを作成。
- Linear: [PLT-4349](https://linear.app/issue/PLT-4349)。
- 5機能の公開API、PGlite・共有ストアRPC、Memory/SQLite/MySQL、native HTTP endpointを実装。
- 公開ドキュメント: [scoped-sync.md](../../../../../scoped-sync.md)。
- Core 124 tests、PGlite 16 tests、playgroundの実WASM/React互換 7 testsが成功。
- WASM生成、全package build、全workspace type-check、lint、rustfmtが成功。npmのpacked consumerから全entrypointのimport/type-check・実WASM/PGlite書込みも成功。
- Memory/SQLite/MySQLの新しいstorage contractを実行済み。MySQLは専用socket/使い捨てDBで実検証。
- 実HTTP + WASM + filesystem PGlite smokeが成功: atomic offline restart、cursor restart、predicate isolation、lost-ACK increment、durable reopen、out-of-scope eviction、remote deletion、full pullなし。
- Rustの対象4 crates（engine/axum/client/server）で67 testsが成功。MySQL環境変数未設定時の条件付きテストは別途の実MySQL実行結果と区別する。
- 対象4 cratesのclippy（all-targets、-D warnings）が成功。最終のdiff check / rustfmt checkも成功。
- 検証用MySQLは停止し一時DBを削除。実HTTP smokeのサーバ・PGlite・SQLiteも終了時に破棄。
- ローカル実装と検証は完了。Ready PRとして提出。CI・マージ・デプロイは別工程。

## 完了条件

5機能の公開API、標準transport/storage実装、既存互換性、失敗・再送・再起動テストが揃うこと。業務ルールとFieldへの組込みは対象外。

## 対象外・境界

業務コマンド/ERPルール、認証プロバイダ、外部APIの冪等性実装、独立したACL変更feed、Fieldへの組込みはホストの責務。既存の全量同期は維持。atomicはサーバ側のoperation/projection受理であり、別々の購読ページをまとめて配信する保証ではない。未送信操作とconflictの値を保持するため、データ回収は暗号学的消去ではない。

公開npmパッケージをmainの0.3.0から0.4.0へminor更新。Rust workspaceの独立バージョンは変更しない。Ready PR用にこのディレクトリへ移動。UI変更なしのためスクリーンショット・ブラウザE2Eは対象外。
