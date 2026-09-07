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

公開npmパッケージをmainの0.3.0から0.4.0へminor更新。Rust workspaceの独立バージョンは変更しない。Ready PR用にこのディレクトリへ移動。見た目の変更はない。Browser E2Eの追加検証と修正は下記。

## PR CIでの追加修正

最初のBrowser E2Eは24/25成功。2つのオフラインwriterの再読込で片方のレコードが消えた。databases routeが作成Promiseを返さずモーダルのawaitを無効化していたため、Promiseを返し戻り型も明記した。保存完了まで閉じない回帰テストを追加。見た目の変更はない。修正後のCIで再検証する。

追加のCreateRecordModalテスト5件と対象ESLintが成功。ローカルPlaywrightはRustサーバの初回コンパイル中にwebServer起動上限120秒に達し、ブラウザテスト未実行。修正後CIのBrowser E2Eを確認する。

2回目CIではオフラインwriterの再読込は成功し、同一ブラウザ2タブのモーダル待ちが15秒でタイムアウトした。再実行CIは全件成功。ローカル計測で、画面描画後の共有PGlite初回起動が28〜31秒かかり、起動後の保存と同期は成功することを確認。該当E2Eの保存完了待ちを60秒、全体上限を180秒へ調整し、永続化・他タブ同期のassertionは維持した。診断ログは除去。

調整後の同一ブラウザ2タブE2Eは、診断コードなしで3回連続成功（44.9秒、44.4秒、33.8秒）。対象ESLintとdiff checkも成功。

## PRレビュー対応

9件の指摘を検証して修正した。

- SnapshotのafterId比較はサーバーの照合順序を尊重し、同一cursorの停止は検出する。
- 1つのselectorが失敗しても残りの購読をrefreshする。
- Atomic siblingの隔離理由を実際の削除・失効と区別する。remote採用は受理済みbaseの復元とconflict解決を同じ永続commitにし、同時編集の二重適用も防ぐ。
- 削除・解放されたレコードをLRU索引からも外す。
- Edge proxyにselection/push-atomicを追加し、atomic受理後もLive通知する。
- 共有ストアはmigration後にownerのoptional capabilityをRPCで確認し、古いadapterの全量同期fallbackを維持する。
- 読込済みon-demandレコードには別タブの更新を適用する。
- 未取得・未認可のIDを失効通知に含めない。保持済みIDを200件ずつ再検証し、走査位置を再起動後も引き継ぐ。
- 拒否・競合を含む終端decisionで、復旧用conflictを保存後にdeferred cacheを回収する。

追加検証: Core 134 tests、photon-axum 40 tests、全package build/workspace type-check、対象ESLint、axum clippyが成功。実HTTP/WASM/filesystem PGlite smokeの8シナリオも再成功。ローカルworkerdからnative serverへのselectionは認証なし401、atomic push受理200、Live hint受信、保存レコードのselection取得200を確認。検証サーバーと使い捨てWorker stateは停止・削除済み。
