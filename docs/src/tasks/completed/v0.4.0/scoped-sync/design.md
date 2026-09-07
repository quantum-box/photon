# 同期範囲と原子的バッチ

## 目的

Photonの同期エンジンとしての契約を拡張する。業務ルール、UI、認証プロバイダはホストが所有する。

## 設計

- 部分同期は明示的な scoped mode と immutable selector（collection、record IDs、フィールド条件）で指定する。既存の全量operation pullは互換維持する。
- 初期取得はrecord IDのkeysetページングと開始時のhigh-watermarkを使う。初期ページング中の変更はそのwatermarkからの差分取得で追いつく。offsetによる欠落を避ける。
- 差分は変更されたレコードのサーバprojectionと、deleted / out_of_scope / revokedの回収通知。selectorをcursorに結び、別selectorへのcursor流用を拒否する。
- 各購読のcursor・取得状態・membershipとprojectionを同一ローカルトランザクションで保存する。空集合の取得完了と未取得を区別する。重複購読では最後のmembershipが消えるまでprojectionを保つ。
- 未送信編集は通常のキャッシュ退避・範囲外通知で失わない。削除・アクセス失効時はconflictへ隔離して自動再送を止める。アクセス失効は表示用projectionを除去するが、編集回収用conflictは保持する（暗号学的消去ではない）。
- ローカルpage queryはPGliteのWHERE / LIMIT / keysetを使い、on-demand collectionの全件をメモリへhydrateしない。pendingと利用中のrecordは退避から保護する。
- RESTにはimmutable operation context（operation ID、scope、actor、期待version、signal）を渡す。既存の少ない引数のcallbackは互換維持。operation contextはログに残し再送で変わらない。
- atomic batchはopt-in。operationにbatch IDとmember ID一覧を保存して再起動後も同じ単位で送る。専用endpointで旧サーバの黙示的部分受理を防ぐ。SQLite/MySQLは同一DB transaction、Memoryは同一lockで全件受理する。非対応transportや複数transportにまたがるbatchはローカル適用前に拒否する。

## 検証

型検査、既存Vitest/Rustテストに加えて、部分取得・空集合・範囲変更・同時書込み中のページング・membership重複・pending保護・再起動cursor・REST再送context・batch一部拒否/DB失敗/重複再送を検証する。UIの変更は行わない。
