import type {
  CloudflareStorageBindings,
  StorageAdapter,
} from "./storage-contract";
import { createD1BlobStore } from "./d1-blob-store";

/**
 * Adapts native Cloudflare bindings to the storage surface consumed by the
 * application. No route or service should construct this shape directly.
 *
 * The built-in object store keeps binary blobs inside D1 (sharded across rows
 * so each stays under the D1 per-row size limit) instead of an R2 bucket. A
 * self-hosted runtime that supplies its own blob store (filesystem or
 * S3-compatible) via the optional RESOURCES binding keeps using it, so the
 * default D1 sharded store only applies when no blob store is bound.
 */
export const createCloudflareStorageAdapter = (
  bindings: CloudflareStorageBindings,
): StorageAdapter => ({
  db: bindings.DB,
  resources: bindings.RESOURCES ?? createD1BlobStore(bindings.DB),
});
