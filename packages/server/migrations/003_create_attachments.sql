CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_provider TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_status TEXT NOT NULL,
  preview_metadata TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_workspace_updated
  ON attachments(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS attachment_links (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  surface_type TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
  UNIQUE (attachment_id, surface_type, surface_id)
);

CREATE INDEX IF NOT EXISTS idx_attachment_links_surface
  ON attachment_links(workspace_id, surface_type, surface_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attachment_links_attachment
  ON attachment_links(attachment_id, created_at DESC);
