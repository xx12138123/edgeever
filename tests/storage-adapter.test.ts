import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createCloudflareStorageAdapter } from "../apps/api/src/cloudflare-storage-adapter";
import { createD1BlobStore, D1_BLOB_SHARD_SIZE } from "../apps/api/src/d1-blob-store";
import type { DatabaseAdapter } from "../apps/api/src/storage-contract";
import { createSelfHostedStorageAdapter } from "../apps/api/src/self-hosted-storage-adapter";
import { SELF_HOSTED_DATABASE_DIALECT } from "../apps/api/src/self-hosted-storage-adapter";
import { createS3CompatibleStorageAdapter } from "../apps/api/src/s3-compatible-storage-adapter";

describe("storage adapter", () => {
  test("wraps Cloudflare bindings without changing their identity", () => {
    const db = { prepare: () => undefined, batch: () => undefined };
    const resources = { get: async () => null, put: async () => undefined, delete: async () => undefined };
    const adapter = createCloudflareStorageAdapter({ DB: db, RESOURCES: resources } as never);

    expect(adapter.db).toBe(db);
    expect(adapter.resources).toBe(resources);
  });

  test("keeps the self-hosted database dialect explicit", () => {
    expect(SELF_HOSTED_DATABASE_DIALECT).toBe("sqlite");
  });

  test("stores attachments in a persistent filesystem directory", async () => {
    const directory = await mkdtemp(`${tmpdir()}/edgeever-storage-`);
    const sqlite = {
      query: () => ({ all: () => [], get: () => null, run: () => undefined }),
      transaction: (callback: () => void) => () => callback(),
    };

    try {
      const adapter = createSelfHostedStorageAdapter(sqlite, directory);
      await adapter.resources.put("workspace/memo/image.bin", new Uint8Array([1, 2, 3]));

      expect(await readFile(`${directory}/workspace/memo/image.bin`)).toEqual(new Uint8Array([1, 2, 3]));
      expect(await adapter.resources.get("workspace/memo/image.bin")).not.toBeNull();
      await adapter.resources.delete("workspace/memo/image.bin");
      expect(await adapter.resources.get("workspace/memo/image.bin")).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects attachment path traversal", async () => {
    const directory = await mkdtemp(`${tmpdir()}/edgeever-storage-`);
    const sqlite = {
      query: () => ({ all: () => [], get: () => null, run: () => undefined }),
      transaction: (callback: () => void) => () => callback(),
    };

    try {
      const adapter = createSelfHostedStorageAdapter(sqlite, directory);
      await expect(adapter.resources.put("../outside", new Uint8Array([1]))).rejects.toThrow(
        "Invalid resource object key",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("maps the common object operations to an S3-compatible client", async () => {
    const commands: string[] = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: { Key?: string } }) => {
        commands.push(`${command.constructor.name}:${command.input.Key ?? ""}`);
        if (command.constructor.name === "GetObjectCommand") {
          return { Body: new Blob(["edgeever"]), ContentLength: 8, ContentType: "text/plain" };
        }
        return {};
      },
    };
    const sqlite = {
      query: () => ({ all: () => [], get: () => null, run: () => undefined }),
      transaction: (callback: () => void) => () => callback(),
    };
    const adapter = createS3CompatibleStorageAdapter(
      sqlite,
      { bucket: "edgeever", endpoint: "http://minio:9000" },
      client as never,
    );

    await adapter.resources.put("memo/image.txt", new Uint8Array([1]), {
      httpMetadata: { contentType: "text/plain" },
    });
    expect(await adapter.resources.get("memo/image.txt")).not.toBeNull();
    await adapter.resources.delete(["memo/image.txt", "memo/other.txt"]);
    expect(commands).toEqual([
      "PutObjectCommand:memo/image.txt",
      "GetObjectCommand:memo/image.txt",
      "DeleteObjectsCommand:",
    ]);
  });
});

describe("D1 blob store", () => {
  type ShardRow = {
    object_key: string;
    shard_index: number;
    data: ArrayBuffer;
    shard_size: number;
    total_size: number;
    shard_count: number;
    content_type: string | null;
    cache_control: string | null;
  };

  const createMockD1 = (): DatabaseAdapter & { rows: Map<string, ShardRow[]> } => {
    const rows = new Map<string, ShardRow[]>();
    return {
      rows,
      prepare(sql: string) {
        const lower = sql.replace(/\s+/g, " ").toLowerCase();
        return {
          bind(...bindings: unknown[]) {
            if (lower.includes("select") && lower.includes("from resource_blobs") && !lower.includes("delete")) {
              const [objectKey] = bindings as [string];
              return {
                all: async () => ({
                  results: (rows.get(objectKey) ?? [])
                    .slice()
                    .sort((a, b) => a.shard_index - b.shard_index) as ShardRow[],
                }),
              };
            }
            if (lower.startsWith("insert into resource_blobs")) {
              const [objectKey, shardIndex, data, shardSize, totalSize, shardCount, contentType, cacheControl] =
                bindings as [string, number, Uint8Array, number, number, number, string | null, string | null];
              const existing = rows.get(objectKey) ?? [];
              existing.push({
                object_key: objectKey,
                shard_index: shardIndex,
                data: data,
                shard_size: shardSize,
                total_size: totalSize,
                shard_count: shardCount,
                content_type: contentType,
                cache_control: cacheControl,
              });
              rows.set(objectKey, existing);
              return { run: async () => undefined };
            }
            if (lower.startsWith("delete from resource_blobs")) {
              const [objectKey] = bindings as [string];
              rows.delete(objectKey);
              return { run: async () => undefined };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          },
        };
      },
      async batch(statements: { run: () => Promise<unknown> }[]) {
        await Promise.all(statements.map((statement) => statement.run()));
      },
    } as never;
  };

  test("round-trips a small file through a single shard and preserves content type", async () => {
    const db = createMockD1();
    const store = createD1BlobStore(db);
    const payload = new Uint8Array([10, 20, 30, 40]);

    await store.put("memo/attachment.bin", payload, {
      httpMetadata: { contentType: "application/pdf", cacheControl: "private, max-age=3600" },
    });

    const object = await store.get("memo/attachment.bin");
    expect(object).not.toBeNull();
    expect(object!.size).toBe(4);

    const headers = new Headers();
    object!.writeHttpMetadata(headers);
    expect(headers.get("Content-Type")).toBe("application/pdf");
    expect(headers.get("Cache-Control")).toBe("private, max-age=3600");

    const reassembled = new Uint8Array(await new Response(object!.body).arrayBuffer());
    expect(reassembled).toEqual(payload);
    expect(db.rows.get("memo/attachment.bin")!.length).toBe(1);
  });

  test("shards and reassembles a file larger than the shard size", async () => {
    const db = createMockD1();
    const store = createD1BlobStore(db);
    const payload = new Uint8Array(D1_BLOB_SHARD_SIZE * 2 + 5);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;

    await store.put("memo/large.bin", payload, {});

    const object = await store.get("memo/large.bin");
    expect(object!.size).toBe(payload.byteLength);
    const reassembled = new Uint8Array(await new Response(object!.body).arrayBuffer());
    expect(reassembled).toEqual(payload);

    const shards = db.rows.get("memo/large.bin")!;
    expect(shards.length).toBe(3);
    expect(shards[0].shard_size).toBe(D1_BLOB_SHARD_SIZE);
    expect(shards[1].shard_size).toBe(D1_BLOB_SHARD_SIZE);
    expect(shards[2].shard_size).toBe(5);
  });

  test("returns null for missing objects", async () => {
    const db = createMockD1();
    const store = createD1BlobStore(db);
    expect(await store.get("missing.bin")).toBeNull();
  });

  test("deletes all shards for an object key", async () => {
    const db = createMockD1();
    const store = createD1BlobStore(db);
    await store.put("memo/a.bin", new Uint8Array([1, 2]), {});
    await store.put("memo/b.bin", new Uint8Array([3, 4]), {});

    await store.delete("memo/a.bin");
    expect(await store.get("memo/a.bin")).toBeNull();
    expect(await store.get("memo/b.bin")).not.toBeNull();
  });

  test("falls back to the D1 blob store when no RESOURCES binding is present", () => {
    const db = { prepare: () => undefined, batch: async () => undefined } as never;
    const adapter = createCloudflareStorageAdapter({ DB: db });
    expect(adapter.db).toBe(db);
    expect(adapter.resources).toBeDefined();
  });
});
