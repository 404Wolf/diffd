-- Reviews: one shared diff and everything said about it.
CREATE TABLE reviews (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    summary     TEXT,
    repo_path   TEXT NOT NULL,
    repo_name   TEXT NOT NULL,
    from_rev    TEXT NOT NULL,
    to_rev      TEXT,               -- NULL: the working tree
    spec        TEXT NOT NULL,      -- JSON ReviewSpec: paths, merge base, collapse rules, watch
    revision    INTEGER NOT NULL,
    status      TEXT NOT NULL,      -- 'open' | 'closed'
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Each rebuild with new content is a revision; the snapshot is zstd-compressed JSON.
CREATE TABLE revisions (
    review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    number      INTEGER NOT NULL,
    snapshot    BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (review_id, number)
);

-- Threads anchored to lines: user comments and agent notes.
CREATE TABLE threads (
    id          TEXT PRIMARY KEY NOT NULL,
    review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,      -- JSON ThreadKind
    anchor      TEXT NOT NULL,      -- JSON Anchor
    resolved    INTEGER NOT NULL DEFAULT 0,
    changed_in  INTEGER,
    outdated    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX threads_by_review ON threads (review_id, created_at);

-- Messages in threads, and chat messages (thread_id IS NULL).
CREATE TABLE messages (
    id            TEXT PRIMARY KEY NOT NULL,
    review_id     TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    thread_id     TEXT REFERENCES threads(id) ON DELETE CASCADE,
    author        TEXT NOT NULL,    -- 'user' | 'agent'
    body          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    delivered_at  INTEGER           -- when the agent received a user message
);
CREATE INDEX messages_by_thread ON messages (thread_id, created_at);
CREATE INDEX messages_undelivered ON messages (review_id) WHERE delivered_at IS NULL AND author = 'user';

-- The activity feed; `seq` orders everything and drives unread state.
CREATE TABLE activity (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    at          INTEGER NOT NULL,
    kind        TEXT NOT NULL       -- JSON ActivityKind
);
CREATE INDEX activity_by_review ON activity (review_id, seq);

-- How far the user has read each review's activity.
CREATE TABLE read_marks (
    review_id   TEXT PRIMARY KEY NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL
);
