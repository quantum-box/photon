CREATE TABLE IF NOT EXISTS yjs_snapshots (
    room_id      TEXT PRIMARY KEY NOT NULL,
    snapshot     BLOB NOT NULL,
    snapshot_seq INTEGER NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS yjs_updates (
    room_id      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    update_bytes BLOB NOT NULL,
    applied_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_yjs_updates_room_seq ON yjs_updates(room_id, seq);
