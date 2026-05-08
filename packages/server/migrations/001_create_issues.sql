CREATE TABLE IF NOT EXISTS issues (
    id          TEXT PRIMARY KEY NOT NULL,
    identifier  TEXT UNIQUE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'backlog',
    priority    TEXT NOT NULL DEFAULT 'none',
    assignee    TEXT,
    labels      TEXT NOT NULL DEFAULT '[]',
    project     TEXT NOT NULL DEFAULT 'Client App Kit',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee);
CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project);
