PRAGMA foreign_keys = ON;

-- D1-sharded blob storage for the built-in object store (replaces the R2
-- RESOURCES bucket). Each logical object is split into ordered shards whose
-- BLOB payload stays below the D1 per-row size limit (2,000,000 bytes).
CREATE TABLE resource_blobs (
  object_key TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  data BLOB NOT NULL,
  shard_size INTEGER NOT NULL CHECK (shard_size >= 0),
  total_size INTEGER NOT NULL CHECK (total_size >= 0),
  shard_count INTEGER NOT NULL CHECK (shard_count > 0),
  content_type TEXT,
  cache_control TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (object_key, shard_index)
);

CREATE INDEX idx_resource_blobs_object
  ON resource_blobs(object_key);