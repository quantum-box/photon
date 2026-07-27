# Photon Attachment Sync

Photon treats attachment metadata as workspace domain data and file bytes as storage-specific content.

## Domain Model

An attachment record holds metadata:

- `workspace_id`, `filename`, `content_type`, `byte_size`
- `storage_provider`, `storage_key`, `content_status`
- `preview_metadata` as JSON for file type and preview readiness
- audit timestamps and optional creator

It also carries `links`, the references from that attachment to workspace surfaces:

- `surface_type`: `record`, `chat`, or `document`
- `surface_id`: the record id, chat thread id, or document id

One attachment can therefore appear in a record, a chat thread, and a document without duplicating content metadata.

## Storage Assumptions

Web builds use `web-object-storage` as the provider name. Until a real object storage bucket is configured, the browser keeps the selected `File` and object URL only in the current runtime cache. Server sync preserves metadata and links, so the attachment chip can be re-displayed after navigation or another client sync, but full preview requires either the original runtime cache or future object storage download URLs.

Tauri builds use the reserved `tauri-local-file-cache` provider name. Desktop should store a local file reference or cached copy outside synced metadata, then put a stable storage key in the server record. The synced record must not contain absolute user filesystem paths.

## Responsibilities

Attachment metadata and surface links are Photon Engine records, carried by the
same operation log as every other structured collection. They are not a bespoke
REST surface: the dedicated `/api/attachments` endpoints were removed once the
client moved onto the engine, because nothing called them.

The client stores them in the engine collection `attachments`, one record per
attachment keyed by attachment id, with its surface links carried inline on the
record rather than as a separate collection. That collection syncs through
`/api/engine/push` and `/api/engine/pull` like any other, so offline creation
and later reconciliation come for free.

The storage provider owns file bytes. Previewers consume local `File` objects or future downloaded blobs. Preview metadata is descriptive only and stays separate from content storage.

Binary content is never written into the operation log or into Yjs.

## Open Work

Permission checks and delete semantics are not yet enforced anywhere: engine
push accepts operations without a user-level authorization boundary. PLT-1189
should apply the same auth boundary used for records/docs/chat before release.
