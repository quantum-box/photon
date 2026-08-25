# Photon 設計思想

> **思考速度で動き、何も失わない。**

Photon のすべての実装判断はこのテーゼに従う。テーゼは以下の3本柱に分解され、
設計レビューでは「この変更はどの柱に反していないか」を判定基準として使う。

Linear の "UI responsiveness should not depend on network latency" と同じ役割の
文書。個別技術の選定理由ではなく、選定を導く原則を書く。
現状とのマッピングは [photon-linear-design-map.html](./photon-linear-design-map.html) を参照。

## 柱1 — ネットワークはループの外にある

*The network is not in the loop.*

読みはメモリ上の projection pool から、書きは operation のローカル適用から始まる。
ネットワークはすべての操作の「後ろ」で動き、ユーザーの1操作の経路に決して入らない。
スピナーを出したくなったら、それはこの柱に違反している証拠。

- 実装対応: projection pool + LiveQuery、楽観 apply、pending operation queue、reject 時のみ rollback

## 柱2 — すべての編集は消えない事実である

*Every edit is a durable fact.*

操作は UI イベントではなく operation(事実の記録)。作業が保証されるのは UI に
映った時点ではなく「ローカルストアに書かれた時点」であり、オフラインはエラー状態
ではなく通常状態。サーバーは事実を検証・受理する権威であって、事実の保管を独占しない。

- 実装対応: durable operation log、push/pull + cursor、offline round trip、two-writer convergence

## 柱3 — コストは変更量に比例する

*Work scales with the delta, not the dataset.*

1フィールドの変更は1セルの再描画(One Delta, One Cell)。起動コストは workspace の
構造に比例し、レコード数には比例しない。sync が運ぶのは差分だけ。
「データが10倍になったら10倍遅くなる」実装はこの柱で却下できる。

- 実装対応: レコード単位の identity 安定 + `useRecordField`。lazy hydration(PLT-3895)と
  セル移行(PLT-3894)が残作業

## 構成原則 — 真実は core が決め、手触りは plugin が足す

柱を支える構造ルール。Photon Engine が唯一の durable truth の経路であり、
Live(presence / 共同編集)や AI は plugin。plugin は落ちても・外しても
柱1〜3が壊れない。Linear が CRDT を description 編集だけに限定しているのと同じ規律。

- 実装対応: Engine/Live の分離、Live を pull ヒントに使う場合も durable truth は運ばない(PLT-3896)

## 判定例

| 提案 | 判定 |
| --- | --- |
| 保存前に確認ダイアログを出して server 応答を待つ | 柱1違反 |
| 送信失敗した編集を破棄して再入力してもらう | 柱2違反 |
| 起動時に全レコードを読み込む | 柱3違反 |
| レコードの本文データを Yjs ドキュメントに載せる | 構成原則違反 |
