-- Showing boards: files agents put in front of the user, per scope (`present`).

-- One item per presented file and scope. Presenting the same file again
-- replaces its content and counts `revision` up, rather than adding an item.
CREATE TABLE board_items (
    id             TEXT PRIMARY KEY NOT NULL,
    scope          TEXT NOT NULL,      -- 'deacon' | a project | a repository's name | 'default'
    key            TEXT NOT NULL,      -- '<machine>:<real path>': what "the same file" means
    kind           TEXT NOT NULL,      -- 'markdown' | 'code' | 'image' | 'text'
    title          TEXT NOT NULL,
    message        TEXT,
    lines          TEXT,               -- JSON [first, last], for code
    language       TEXT,               -- for code: the language's display name
    source         TEXT NOT NULL,      -- JSON BoardItemSource
    assets         TEXT NOT NULL,      -- JSON [name]: the images bundled with a document
    revision       INTEGER NOT NULL,
    state          TEXT NOT NULL,      -- 'open' | 'minimised' | 'hidden'
    seen_revision  INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX board_items_by_key ON board_items (scope, key);
CREATE INDEX board_items_by_scope ON board_items (scope, updated_at);

-- The item's file (name '') and its bundled images, as of its latest revision; zstd-compressed.
CREATE TABLE board_assets (
    item_id  TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    mime     TEXT NOT NULL,
    bytes    BLOB NOT NULL,
    PRIMARY KEY (item_id, name)
);
