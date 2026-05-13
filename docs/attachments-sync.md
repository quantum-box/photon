# Photon Attachment Sync

Photon treats attachment metadata as workspace domain data and file bytes as storage-specific content.

## Domain Model

`attachments` stores metadata:

- `workspace_id`, `filename`, `content_type`, `byte_size`
- `storage_provider`, `storage_key`, `content_status`
- `preview_metadata` as JSON for file type and preview readiness
- audit timestamps and optional creator

`attachment_links` stores references from the same attachment to workspace surfaces:

- `surface_type`: `issue`, `chat`, or `document`
- `surface_id`: the issue id, chat thread id, or document id

One attachment can therefore appear in an issue, a chat thread, and a document without duplicating content metadata.

## Storage Assumptions

Web builds use `web-object-storage` as the provider name. Until a real object storage bucket is configured, the browser keeps the selected `File` and object URL only in the current runtime cache. Server sync preserves metadata and links, so the attachment chip can be re-displayed after navigation or another client sync, but full preview requires either the original runtime cache or future object storage download URLs.

Tauri builds use the reserved `tauri-local-file-cache` provider name. Desktop should store a local file reference or cached copy outside synced metadata, then put a stable storage key in the server record. The synced record must not contain absolute user filesystem paths.

## Responsibilities

The application server owns attachment metadata, surface links, permission checks, and delete semantics through `/api/attachments`.

The storage provider owns file bytes. Previewers consume local `File` objects or future downloaded blobs. Preview metadata is descriptive only and stays separate from content storage.

The Yjs workspace projection mirrors attachment metadata into the frontend alongside issues so surfaces can render attachment chips immediately after sync. Binary content is never written into Yjs.

## API Shape

- `GET /api/attachments?workspace_id=...`
- `GET /api/attachments?workspace_id=...&surface_type=issue&surface_id=...`
- `POST /api/attachments`
- `GET /api/attachments/:id`
- `PUT /api/attachments/:id`
- `DELETE /api/attachments/:id`
- `POST /api/attachments/:id/links`
- `DELETE /api/attachments/:id/links/:link_id`

Current local development has no auth layer, so these endpoints are workspace-scoped but not user-authorized. PLT-1189 should harden this with the same auth boundary used for issues/docs/chat before release.
