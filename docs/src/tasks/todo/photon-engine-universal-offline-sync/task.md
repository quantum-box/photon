---
title: "Photon Engine: Universal Offline Sync Core"
type: "tech"
emoji: "⚙️"
topics:
  - "photon"
  - "offline-first"
  - "sync-engine"
  - "rust"
  - "wasm"
  - "pglite"
  - "tidb"
  - "postgres"
published: true
targetFiles:
  - "packages/"
  - "src/lib/yjs/"
  - "src/lib/docs/"
  - "packages/server/"
  - "src-tauri/"
github: "https://github.com/quantum-box/photon"
---

# Photon Engine: Universal Offline Sync Core

## 概要

Photon Engine は、Photon と Tachyon 全体で使える local-first durable sync core として設計する。
Rust core を中心に据え、API server / Tauri では Rust crate として、ブラウザでは WASM + TypeScript wrapper として利用できる形を目指す。

この engine はリアルタイム通信そのものを責務にしない。責務は、ローカル DB 永続化、operation log、push/pull sync、materialized projection、競合解決、server reconciliation に限定する。WebSocket、presence、cursor、Yjs relay、Durable Object room は engine の外側に置き、必要に応じて `sync_once` を起動する transport / UX layer として扱う。

## 背景・目的

現在の Photon は、ブラウザ側に Yjs + IndexedDB、docs 用に PGlite、Rust server 側に SQLite + yrs + REST / WebSocket sync があり、同期と正本の責務が複数の場所に分かれている。既存 ADR では、Durable Object や WebSocket relay は canonical application server ではなく、domain data の正本は application server が持つという境界を定義している。

今回の目的は、この境界をさらに進めて、Photon / Tachyon のあらゆる実行場所で使える共通の offline-first sync engine を作ること。ブラウザ、Tauri、API server、将来の mobile / edge / on-premise runtime で同じ永続化・同期・競合解決モデルを使えるようにする。

この部分は Photon / Tachyon の中核的な差別化になるため、当面は private repo / private core package として育てる。公開する場合も、将来的に protocol spec、薄い SDK、または examples など、公開範囲を明確に切る。

## 詳細仕様

### 責務境界

- ✅ Photon Engine が責務を持つもの
  - local DB への durable persistence
  - append-only operation log
  - materialized projection
  - sync cursor / checkpoint 管理
  - pending operation の retry / dedupe
  - server accepted / rejected / conflict result の反映
  - deterministic conflict resolution
  - storage adapter contract

- 📝 Photon Engine が責務を持たないもの
  - WebSocket 接続管理
  - presence / cursor / online count
  - Yjs awareness
  - push notification
  - file bytes / object storage 本体
  - auth session UI
  - API gateway routing

### 実行環境

- Rust crate: API server、Tauri、CLI、batch、on-premise worker から直接利用する。
- WASM package: browser / webview から利用し、TypeScript wrapper を提供する。
- Server integration: Tachyon API server では permission、audit、multi-tenancy、domain validation を通したうえで engine に accepted operation を渡す。
- Browser integration: PGlite や IndexedDB-backed storage を使い、offline mutation を pending operation として保持する。

### データモデル

v1 は Photon surfaces 専用ではなく、generic records を扱う。

- `record`: domain entity の現在 projection。例: issue、document metadata、attachment metadata、chat message、tool call。
- `operation`: actor が発行した append-only mutation。offline 中も必ず保存する。
- `collection`: record namespace。例: `issues`, `documents`, `attachments`, `chat_messages`。
- `scope`: workspace / tenant / operator / user などの境界。
- `cursor`: remote との同期位置。
- `conflict`: 自動解決できない、または server validation で拒否された mutation の記録。
- `snapshot`: document / CRDT payload や projection の compaction 結果。

### Storage Adapter

DB 固有の差は adapter に閉じ込める。

- Postgres / PGlite compatible adapter
- MySQL / TiDB compatible adapter
- SQLite adapter
- browser 用 PGlite adapter
- test 用 memory adapter

adapter は少なくとも次の contract を満たす。

- operation append が transactionally durable であること
- idempotent replay ができること
- cursor update と operation append の順序が壊れないこと
- projection rebuild が deterministic であること
- same test suite を全 adapter で実行できること

### Sync Protocol

realtime transport ではなく、HTTP / RPC で呼べる pull/push protocol を first-class にする。

- `push`: local pending operations を server に送る。
- `push_result`: accepted / rejected / conflict / server_patch を返す。
- `pull`: cursor 以降の remote operations または snapshots を取得する。
- `ack`: local cursor を進める。
- `compact`: log / snapshot の compaction を行う。

WebSocket や Durable Object は、この protocol を素早く起動する通知・relay としてのみ使う。

### Conflict Policy

初期方針は hybrid にする。

- 文書本文や collaborative payload は Yjs / yrs の CRDT として扱い、snapshot + update log を保存する。
- 業務 record は field-level policy で deterministic に解決する。
- scalar は default で `last-write-wins`。Hybrid Logical Clock と actor id tie-break を使う。
- set は add-wins を default にする。
- counter は increment / decrement operation を合成する。
- delete と update が競合した場合は collection policy で決める。default は tombstone を優先し、復元は明示 operation にする。
- workflow status、unique constraint、permission-sensitive field は server validation / domain resolver に委ねる。
- 自動解決できないものは `conflicts` に保存し、UI が解決できる形で返す。

## 実装方針

### Phase 1: Issues を engine-backed record に移す 🔄

- [ ] `photon-engine` Rust crate の package boundary を作る
- [ ] generic operation / record / cursor / conflict 型を定義する
- [ ] local storage adapter contract を定義する
- [ ] PGlite / SQLite のどちらかで最初の adapter を作る
- [ ] issue CRUD を operation log に載せる
- [ ] 既存 Yjs issues projection との split-brain を解消する
- [ ] `packages/server` の REST issue API と engine projection を一致させる

### Phase 2: Docs / Yjs snapshot を engine 管理に寄せる 📝

- [ ] document metadata を generic record にする
- [ ] Yjs update / snapshot を engine の snapshot stream として保存する
- [ ] snapshot compaction policy を定義する
- [ ] docs の PGlite metadata と Yjs document storage の境界を整理する

### Phase 3: Attachments / Chat / Tool Calls を載せる 📝

- [ ] attachment metadata と surface link を generic record にする
- [ ] file bytes は storage provider に残し、engine には reference のみ保存する
- [ ] chat messages / tool calls / tool results を collection 化する
- [ ] offline draft と server accepted history の reconciliation を定義する

### Phase 4: Tachyon integration 📝

- [ ] Tachyon multi-tenancy scope と Photon Engine scope を対応づける
- [ ] server-side permission / audit / validation hook を追加する
- [ ] API server / Tauri / browser で同じ sync contract を使う
- [ ] private dependency として Tachyon apps から取り込める package layout を決める

## テスト計画

- [ ] storage adapter contract test
  - operation append
  - cursor update
  - idempotent replay
  - projection rebuild
  - transaction rollback
- [ ] offline two-client convergence test
  - client A / B が offline 編集
  - 順不同 push
  - retry / duplicate push
  - final projection の一致
- [ ] conflict policy test
  - scalar 同時更新
  - set add/remove
  - delete/update
  - status transition rejection
  - unique key collision
- [ ] WASM/browser test
  - PGlite `idb://` persistence
  - reload 復元
  - offline mutation
  - reconnect sync
- [ ] Photon E2E
  - issue 作成/編集
  - docs edit
  - attachment metadata sync
  - WebSocket relay なしでも `sync_once` で復帰

## リスクと対策

- リスク: realtime と durable sync の責務が混ざる
  - 対策: engine API は `sync_once` / `push` / `pull` に限定し、WebSocket は外側の trigger にする。
- リスク: DB adapter ごとの SQL 方言差で core が汚れる
  - 対策: storage adapter contract と migration adapter を分ける。
- リスク: CRDT everywhere に寄りすぎて業務データの監査や権限が難しくなる
  - 対策: 文書本文は CRDT、業務 record は operation + projection + server validation に分ける。
- リスク: offline mutation が server permission で拒否された時に UI が破綻する
  - 対策: rejection / conflict を first-class record として保存し、compensating op で projection を戻せるようにする。
- リスク: core 技術が早すぎる公開で差別化を失う
  - 対策: engine core と conflict resolver は private に保ち、公開範囲は後で切る。

## スケジュール

- Milestone 1: architecture skeleton と storage adapter contract
- Milestone 2: issues の engine-backed projection
- Milestone 3: browser WASM / PGlite integration
- Milestone 4: docs / Yjs snapshot integration
- Milestone 5: Tachyon API integration design

## 完了条件

- [ ] Photon Engine の Rust core が最低 1 adapter で動作する
- [ ] browser から WASM / TS wrapper 経由で local mutation を保存できる
- [ ] issue data が engine projection と server API で一致する
- [ ] offline two-client convergence test が通る
- [ ] conflict policy の初期セットが test で固定されている
- [ ] private package / repo 運用方針が README または ADR に記録されている

## 実装メモ

- 2026-05-15: 初期 taskdoc を作成。現時点では実装前の設計・追跡ドキュメントとして扱う。
