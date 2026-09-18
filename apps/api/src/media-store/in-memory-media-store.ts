import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type {
  MediaStore,
  PutObjectInput,
  StoredObject,
  StoredObjectInfo,
} from './media-store.js';

/** The store other modules' tests run against; nothing leaves the process. */
export class InMemoryMediaStore implements MediaStore {
  private readonly objects = new Map<
    string,
    { body: Buffer; contentType: string }
  >();

  async put(input: PutObjectInput): Promise<void> {
    if (!('contentLength' in input)) {
      this.objects.set(input.key, {
        body: input.body,
        contentType: input.contentType,
      });
      return;
    }

    const body = await buffer(input.body);

    // A real store rejects a body whose length is not what was announced.
    if (body.byteLength !== input.contentLength) {
      throw new Error(
        `Body is ${body.byteLength} bytes but ${input.contentLength} were announced`,
      );
    }

    this.objects.set(input.key, { body, contentType: input.contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    const stored = this.objects.get(key);

    if (!stored) {
      return null;
    }

    return {
      body: Readable.from(stored.body),
      contentType: stored.contentType,
      contentLength: stored.body.byteLength,
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    const stored = this.objects.get(key);

    if (!stored) {
      return null;
    }

    return {
      contentType: stored.contentType,
      contentLength: stored.body.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async assertReady(): Promise<void> {}

  /** Every key currently held, for assertions about what a feature wrote. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}
