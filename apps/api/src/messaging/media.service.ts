import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import type { PrismaClient } from '@repo/db';
import type {
  MessageMediaUploadSlotResponse,
  MessagePreparedMedia,
  RequestMessageMediaUpload,
} from '@repo/dto';
import {
  MESSAGE_UPLOAD_ALLOWED_MIME_TYPES,
  MESSAGE_UPLOAD_MAX_SIZE_BYTES,
} from '@repo/dto';
import type { TwilioCredentials } from '../config.js';
import type { MediaStore } from '../media-store/index.js';
import type { MessagingLogger } from './logger.js';

const PREPARED_MEDIA_TTL_MS = 60 * 60 * 1000;

export interface MessagingMediaServiceOptions {
  db: PrismaClient;
  /** Holds upload slots under `messaging/prepared/` and attachments under `messaging/messages/`. */
  mediaStore: MediaStore;
  /** Public base URL of this API, used to build media and upload links. */
  publicUrl: string;
  /** Presented when downloading inbound media hosted by Twilio. */
  credentials: TwilioCredentials | null;
  log: Pick<MessagingLogger, 'warn'>;
  fetch?: typeof fetch;
}

export type MessagingMediaErrorCode =
  | 'not_found'
  | 'expired'
  | 'consumed'
  | 'not_uploaded'
  | 'empty'
  | 'content_type_mismatch'
  | 'too_large';

/** A media request the caller can act on; the code says how. */
export class MessagingMediaError extends Error {
  constructor(
    readonly code: MessagingMediaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MessagingMediaError';
  }
}

interface UploadPreparedMediaInput {
  preparedMediaId: string;
  token: string;
  body: Buffer;
  contentType: string | undefined;
}

interface PromotePreparedMediaInput {
  messageId: string;
  preparedMediaId: string;
}

interface InboundMediaAttachment {
  url: string;
  mimeType: string | null;
  fileName: string | null;
}

export interface StoredMediaFile {
  mimeType: string;
  sizeBytes: number;
  content: Readable;
}

export class MessagingMediaService {
  private readonly db: PrismaClient;
  private readonly mediaStore: MediaStore;
  private readonly publicUrl: string;
  private readonly credentials: TwilioCredentials | null;
  private readonly log: Pick<MessagingLogger, 'warn'>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MessagingMediaServiceOptions) {
    this.db = options.db;
    this.mediaStore = options.mediaStore;
    this.publicUrl = options.publicUrl;
    this.credentials = options.credentials;
    this.log = options.log;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async requestUploadSlot(
    userId: string,
    input: RequestMessageMediaUpload,
  ): Promise<MessageMediaUploadSlotResponse> {
    const preparedMediaId = randomUUID();
    const uploadToken = randomUUID();
    const record = await this.db.messagePreparedMedia.create({
      data: {
        id: preparedMediaId,
        storageUrl: preparedMediaKey(preparedMediaId),
        publicUrl: `${this.publicUrl}/media/messaging/prepared/${preparedMediaId}`,
        mimeType: input.mimeType,
        fileName: input.fileName,
        sizeBytes: input.sizeBytes,
        uploadedByUserId: userId,
        uploadToken,
        expiresAt: new Date(Date.now() + PREPARED_MEDIA_TTL_MS),
      },
    });

    return {
      preparedMedia: mapPreparedMedia(record),
      uploadUrl: `${this.publicUrl}/api/user/messages/media/uploads/${record.id}?token=${uploadToken}`,
      uploadMethod: 'PUT',
      maxSizeBytes: MESSAGE_UPLOAD_MAX_SIZE_BYTES,
      allowedMimeTypes: [...MESSAGE_UPLOAD_ALLOWED_MIME_TYPES],
    };
  }

  async uploadPreparedMedia(input: UploadPreparedMediaInput): Promise<void> {
    const preparedMedia = await this.db.messagePreparedMedia.findUnique({
      where: { id: input.preparedMediaId },
    });

    if (!preparedMedia || preparedMedia.uploadToken !== input.token) {
      throw new MessagingMediaError(
        'not_found',
        'Prepared media upload slot not found',
      );
    }

    if (preparedMedia.expiresAt.getTime() <= Date.now()) {
      throw new MessagingMediaError(
        'expired',
        'Prepared media upload slot has expired',
      );
    }

    if (preparedMedia.consumedAt) {
      throw new MessagingMediaError(
        'consumed',
        'Prepared media upload slot has already been consumed',
      );
    }

    if (input.contentType !== preparedMedia.mimeType) {
      throw new MessagingMediaError(
        'content_type_mismatch',
        'Uploaded content type does not match the prepared media slot',
      );
    }

    if (input.body.byteLength > MESSAGE_UPLOAD_MAX_SIZE_BYTES) {
      throw new MessagingMediaError(
        'too_large',
        'Uploaded media exceeds the MMS size limit',
      );
    }

    await this.mediaStore.put({
      key: preparedMediaKey(preparedMedia.id),
      body: input.body,
      contentType: preparedMedia.mimeType,
    });
  }

  async completeUpload(
    userId: string,
    preparedMediaId: string,
  ): Promise<MessagePreparedMedia> {
    const preparedMedia = await this.db.messagePreparedMedia.findFirst({
      where: {
        id: preparedMediaId,
        uploadedByUserId: userId,
      },
    });

    if (!preparedMedia) {
      throw new MessagingMediaError(
        'not_found',
        'Prepared media upload slot not found',
      );
    }

    if (preparedMedia.expiresAt.getTime() <= Date.now()) {
      throw new MessagingMediaError(
        'expired',
        'Prepared media upload slot has expired',
      );
    }

    const { sizeBytes } = await this.statPreparedMedia(preparedMedia.id);
    if (sizeBytes <= 0) {
      throw new MessagingMediaError('empty', 'Prepared media upload is empty');
    }

    const updated = await this.db.messagePreparedMedia.update({
      where: { id: preparedMedia.id },
      data: {
        uploadedAt: new Date(),
        sizeBytes,
      },
    });

    return mapPreparedMedia(updated);
  }

  /** Bytes the provider fetches while sending an MMS; gone once the slot expires. */
  async openPreparedMedia(preparedMediaId: string): Promise<StoredMediaFile> {
    const preparedMedia = await this.db.messagePreparedMedia.findUnique({
      where: { id: preparedMediaId },
    });

    if (!preparedMedia) {
      throw new MessagingMediaError('not_found', 'Prepared media not found');
    }

    if (preparedMedia.expiresAt.getTime() <= Date.now()) {
      throw new MessagingMediaError('expired', 'Prepared media has expired');
    }

    return this.openStoredFile(
      preparedMediaKey(preparedMedia.id),
      preparedMedia.mimeType,
    );
  }

  async openMessageMedia(messageMediaId: string): Promise<StoredMediaFile> {
    const media = await this.db.messageMedia.findUnique({
      where: { id: messageMediaId },
    });

    if (!media) {
      throw new MessagingMediaError('not_found', 'Message media not found');
    }

    return this.openStoredFile(messageMediaKey(media.id), media.mimeType);
  }

  async getPreparedMediaForSend(userId: string, preparedMediaId: string) {
    const preparedMedia = await this.db.messagePreparedMedia.findFirst({
      where: {
        id: preparedMediaId,
        uploadedByUserId: userId,
        consumedAt: null,
      },
    });

    if (!preparedMedia) {
      throw new MessagingMediaError('not_found', 'Prepared media not found');
    }

    if (preparedMedia.expiresAt.getTime() <= Date.now()) {
      throw new MessagingMediaError('expired', 'Prepared media has expired');
    }

    if (!preparedMedia.uploadedAt) {
      throw new MessagingMediaError(
        'not_uploaded',
        'Prepared media upload has not been completed',
      );
    }

    await this.statPreparedMedia(preparedMedia.id);

    return preparedMedia;
  }

  /**
   * Copies the uploaded object under the attachment's own key, then records
   * the attachment and consumes the slot in one transaction. The copy runs
   * first and on its own so no database connection waits on object storage.
   */
  async promotePreparedMediaToMessage({
    messageId,
    preparedMediaId,
  }: PromotePreparedMediaInput) {
    const preparedMedia = await this.db.messagePreparedMedia.findUnique({
      where: { id: preparedMediaId },
    });

    if (!preparedMedia) {
      throw new MessagingMediaError('not_found', 'Prepared media not found');
    }

    const stored = await this.mediaStore.get(
      preparedMediaKey(preparedMedia.id),
    );

    if (!stored) {
      throw new MessagingMediaError(
        'not_uploaded',
        'Prepared media upload has not been received',
      );
    }

    const mediaId = randomUUID();
    await this.mediaStore.put({
      key: messageMediaKey(mediaId),
      // Buffered so the store can retry the write; MMS attachments are small.
      body: await buffer(stored.body),
      contentType: stored.contentType,
    });

    return this.db.$transaction(async (tx) => {
      const messageMedia = await tx.messageMedia.create({
        data: {
          id: mediaId,
          messageId,
          storageUrl: this.messageMediaPublicUrl(mediaId),
          originalUrl: null,
          mimeType: preparedMedia.mimeType,
          fileName: preparedMedia.fileName,
          sizeBytes: preparedMedia.sizeBytes,
        },
      });

      await tx.messagePreparedMedia.update({
        where: { id: preparedMedia.id },
        data: {
          consumedAt: new Date(),
        },
      });

      return messageMedia;
    });
  }

  /**
   * Records every attachment even when its download fails, so the original
   * provider URL is kept for a later retry. Download failures are logged, not
   * raised: the inbound message is already persisted.
   */
  async ingestInboundMedia(
    messageId: string,
    attachments: InboundMediaAttachment[],
  ) {
    for (const attachment of attachments) {
      const mediaId = randomUUID();
      const mimeType = attachment.mimeType ?? 'application/octet-stream';
      let sizeBytes: number | null = null;

      try {
        const response = await this.fetchImpl(attachment.url, {
          headers: this.inboundMediaHeaders(attachment.url),
        });

        if (!response.ok) {
          throw new Error(`Inbound media download returned ${response.status}`);
        }

        const body = Buffer.from(await response.arrayBuffer());
        await this.mediaStore.put({
          key: messageMediaKey(mediaId),
          body,
          contentType: mimeType,
        });
        sizeBytes = body.byteLength;
      } catch (error) {
        this.log.warn(
          {
            messageId,
            mediaId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Inbound MMS media download failed',
        );
      }

      await this.db.messageMedia.create({
        data: {
          id: mediaId,
          messageId,
          storageUrl: this.messageMediaPublicUrl(mediaId),
          originalUrl: attachment.url,
          mimeType,
          fileName:
            attachment.fileName ?? basename(new URL(attachment.url).pathname),
          sizeBytes,
        },
      });
    }
  }

  /** Account credentials go only to Twilio's own API host, never to an arbitrary URL. */
  private inboundMediaHeaders(url: string): Record<string, string> {
    if (!this.credentials || !isTwilioApiUrl(url)) {
      return {};
    }

    const { accountSid, authToken } = this.credentials;
    return {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
    };
  }

  private async openStoredFile(
    key: string,
    mimeType: string,
  ): Promise<StoredMediaFile> {
    const stored = await this.mediaStore.get(key);

    if (!stored) {
      throw new MessagingMediaError('not_found', 'Media file not found');
    }

    return {
      mimeType,
      sizeBytes: stored.contentLength,
      content: stored.body,
    };
  }

  private async statPreparedMedia(
    preparedMediaId: string,
  ): Promise<{ sizeBytes: number }> {
    const stored = await this.mediaStore.head(
      preparedMediaKey(preparedMediaId),
    );

    if (!stored) {
      throw new MessagingMediaError(
        'not_uploaded',
        'Prepared media upload has not been received',
      );
    }

    return { sizeBytes: stored.contentLength };
  }

  private messageMediaPublicUrl(messageMediaId: string) {
    return `${this.publicUrl}/media/messaging/messages/${messageMediaId}`;
  }
}

function preparedMediaKey(preparedMediaId: string) {
  return `messaging/prepared/${preparedMediaId}`;
}

function messageMediaKey(messageMediaId: string) {
  return `messaging/messages/${messageMediaId}`;
}

function isTwilioApiUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (
      protocol === 'https:' &&
      (hostname === 'api.twilio.com' || hostname.endsWith('.api.twilio.com'))
    );
  } catch {
    return false;
  }
}

function mapPreparedMedia(record: {
  id: string;
  publicUrl: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  expiresAt: Date;
}): MessagePreparedMedia {
  return {
    id: record.id,
    publicUrl: record.publicUrl,
    mimeType: record.mimeType as MessagePreparedMedia['mimeType'],
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    expiresAt: record.expiresAt.toISOString(),
  };
}
