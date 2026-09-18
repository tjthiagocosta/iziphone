import type { Readable } from 'node:stream';

/**
 * Where the API keeps the bytes that are not rows: MMS attachments today,
 * recordings and hosted greetings later. Keys are the calling feature's
 * business (`messaging/<id>`); the store only namespaces them.
 */
export interface MediaStore {
  put(input: PutObjectInput): Promise<void>;
  /** Resolves `null` when nothing is stored under the key. */
  get(key: string): Promise<StoredObject | null>;
  /** The object's type and size without its body; `null` when nothing is stored under the key. */
  head(key: string): Promise<StoredObjectInfo | null>;
  /** Deleting a key that holds nothing is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Resolves when the store is reachable with the configured credentials and
   * rejects with the reason otherwise, so a health route can report it.
   */
  assertReady(): Promise<void>;
}

/** A stream body must come with its length; a Buffer knows its own. */
export type PutObjectInput =
  | { key: string; contentType: string; body: Buffer }
  | { key: string; contentType: string; body: Readable; contentLength: number };

export interface StoredObjectInfo {
  contentType: string;
  contentLength: number;
}

export interface StoredObject extends StoredObjectInfo {
  body: Readable;
}
