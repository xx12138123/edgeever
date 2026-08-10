import type {
  BlobObjectAdapter,
  BlobStoreAdapter,
  DatabaseAdapter,
} from "./storage-contract";

/**
 * Shard size for D1 blob storage. Cloudflare D1 caps a single string/BLOB or
 * table row at 2,000,000 bytes. Each shard carries a small amount of metadata
 * alongside the BLOB payload, so the payload is kept at 1,900,000 bytes to stay
 * safely under the per-row limit while remaining close to the 2 MB ceiling.
 */
export const D1_BLOB_SHARD_SIZE = 1_900_000;

type BlobMetadataRow = {
  shard_index: number;
  data: ArrayBuffer;
  shard_size: number;
  total_size: number;
  shard_count: number;
  content_type: string | null;
  cache_control: string | null;
};

const toUint8Array = async (value: unknown): Promise<Uint8Array> => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
};

/**
 * Builds a BlobStoreAdapter that persists binary objects inside D1, splitting
 * each object into ordered shards so every row stays under the D1 row-size
 * limit. This replaces the R2 RESOURCES bucket for the built-in storage path
 * while keeping the exact same get/put/delete contract the routes depend on.
 */
export const createD1BlobStore = (db: DatabaseAdapter): BlobStoreAdapter => ({
  async get(objectKey): Promise<BlobObjectAdapter | null> {
    const rows = await db
      .prepare(
        `SELECT shard_index, data, shard_size, total_size, shard_count, content_type, cache_control
         FROM resource_blobs
         WHERE object_key = ?
         ORDER BY shard_index ASC`,
      )
      .bind(objectKey)
      .all<BlobMetadataRow>();

    if (rows.results.length === 0) return null;

    const contentType = rows.results[0].content_type;
    const cacheControl = rows.results[0].cache_control;
    const totalSize = rows.results[0].total_size;

    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const row of rows.results) {
      const shard = new Uint8Array(row.data);
      assembled.set(shard, offset);
      offset += shard.byteLength;
    }

    return {
      body: new Response(assembled).body as ReadableStream<Uint8Array>,
      size: totalSize,
      writeHttpMetadata: (headers) => {
        if (contentType) headers.set("Content-Type", contentType);
        if (cacheControl) headers.set("Cache-Control", cacheControl);
      },
    };
  },

  async put(objectKey, value, options) {
    const metadata = options as
      | { httpMetadata?: { contentType?: string; cacheControl?: string } }
      | undefined;
    const httpMetadata = metadata?.httpMetadata ?? {};
    const bytes = await toUint8Array(value);
    const totalSize = bytes.byteLength;
    const shardCount = Math.max(1, Math.ceil(totalSize / D1_BLOB_SHARD_SIZE));
    const contentType = httpMetadata.contentType ?? null;
    const cacheControl = httpMetadata.cacheControl ?? null;

    const statements = [];
    for (let index = 0; index < shardCount; index++) {
      const start = index * D1_BLOB_SHARD_SIZE;
      const end = Math.min(start + D1_BLOB_SHARD_SIZE, totalSize);
      const shard = bytes.subarray(start, end);
      statements.push(
        db
          .prepare(
            `INSERT INTO resource_blobs
             (object_key, shard_index, data, shard_size, total_size, shard_count, content_type, cache_control)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            objectKey,
            index,
            new Uint8Array(shard),
            shard.byteLength,
            totalSize,
            shardCount,
            contentType,
            cacheControl,
          ),
      );
    }
    await db.batch(statements);
  },

  async delete(objectKeys) {
    const keys = Array.isArray(objectKeys) ? objectKeys : [objectKeys];
    const statements = keys.map((key) =>
      db.prepare(`DELETE FROM resource_blobs WHERE object_key = ?`).bind(key),
    );
    await db.batch(statements);
  },
});