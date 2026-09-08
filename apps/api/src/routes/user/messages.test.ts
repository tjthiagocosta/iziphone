import type { Message } from '@repo/dto';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageSendService } from '../../services/messaging/message-send.service.js';
import {
  MessagingMediaError,
  MessagingMediaService,
} from '../../services/messaging/messaging-media.service.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../../test/route-test-helpers.js';
import messageRoutes from './messages.js';

const SENDER_NUMBER = '+15555550100';
const CONTACT_NUMBER = '+15555550123';

/** Mirrors how `userRoutes` mounts the plugin: authenticated. */
const routesUnderTest: FastifyPluginAsync = async (fastify) => {
  await fastify.register(withAuthenticatedUser(messageRoutes));
};

describe('messageRoutes', () => {
  let app: FastifyInstance;
  let sendSmsSpy: ReturnType<typeof spyOn>;
  let sendMmsSpy: ReturnType<typeof spyOn>;
  let requestUploadSlotSpy: ReturnType<typeof spyOn>;
  let uploadPreparedMediaSpy: ReturnType<typeof spyOn>;
  let completeUploadSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    sendSmsSpy = vi
      .spyOn(MessageSendService.prototype, 'sendSms')
      .mockResolvedValue({
        outcome: 'sent',
        conversationId: 'conversation-1',
        message: buildMessage(),
      });
    sendMmsSpy = vi
      .spyOn(MessageSendService.prototype, 'sendMms')
      .mockResolvedValue({
        outcome: 'sent',
        conversationId: 'conversation-1',
        message: buildMessage({
          id: 'message-2',
          channel: 'MMS',
          body: 'Photo',
          attachments: [
            {
              id: 'media-1',
              storageUrl: 'https://api.example.com/media/messages/media-1',
              originalUrl: null,
              mimeType: 'image/png',
              fileName: 'image.png',
              sizeBytes: 128000,
              createdAt: '2026-04-06T12:00:00.000Z',
            },
          ],
        }),
      });
    requestUploadSlotSpy = vi
      .spyOn(MessagingMediaService.prototype, 'requestUploadSlot')
      .mockResolvedValue({
        preparedMedia: {
          id: 'prepared-1',
          publicUrl: 'https://api.example.com/media/prepared/prepared-1',
          mimeType: 'image/png',
          fileName: 'image.png',
          sizeBytes: 128000,
          expiresAt: '2026-04-06T13:00:00.000Z',
        },
        uploadUrl:
          'https://api.example.com/api/user/messages/media/uploads/prepared-1?token=token-1',
        uploadMethod: 'PUT',
        maxSizeBytes: 614400,
        allowedMimeTypes: [
          'image/jpeg',
          'image/png',
          'image/gif',
          'application/pdf',
        ],
      });
    uploadPreparedMediaSpy = vi
      .spyOn(MessagingMediaService.prototype, 'uploadPreparedMedia')
      .mockResolvedValue();
    completeUploadSpy = vi
      .spyOn(MessagingMediaService.prototype, 'completeUpload')
      .mockResolvedValue({
        id: 'prepared-1',
        publicUrl: 'https://api.example.com/media/prepared/prepared-1',
        mimeType: 'image/png',
        fileName: 'image.png',
        sizeBytes: 128000,
        expiresAt: '2026-04-06T13:00:00.000Z',
      });

    app = await createApiRouteApp(routesUnderTest, { db: {} });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should send an SMS with a raw to number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: '(555) 555-0123',
        body: 'Hello there',
        idempotencyKey: 'sms-1',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      conversationId: 'conversation-1',
      message: buildMessage(),
      deduplicated: false,
    });
    expect(sendSmsSpy).toHaveBeenCalledWith('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: '(555) 555-0123',
      body: 'Hello there',
      idempotencyKey: 'sms-1',
    });
  });

  test('should send an SMS with an existing conversation id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        conversationId: 'conversation-1',
        body: 'Hello there',
        idempotencyKey: 'sms-2',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(sendSmsSpy).toHaveBeenCalledWith('user-1', {
      fromPhoneNumberId: 'phone-1',
      conversationId: 'conversation-1',
      body: 'Hello there',
      idempotencyKey: 'sms-2',
    });
  });

  test('should reject invalid SMS payloads', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        attachments: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Invalid input: expected string, received undefined',
    });
  });

  test('should reject invalid destination numbers before the service runs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: 'abc',
        body: 'Hello there',
        idempotencyKey: 'sms-invalid-destination',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message:
        'Phone number must be a valid E.164 or 10-digit North American number',
    });
  });

  test('should reject SMS bodies that exceed the provider limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'a'.repeat(1601),
        idempotencyKey: 'sms-too-long',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(sendSmsSpy).not.toHaveBeenCalled();
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Too big: expected string to have <=1600 characters',
    });
  });

  test('should return 404 when the sender cannot be used', async () => {
    sendSmsSpy.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'sender_not_found',
      detail: 'Sender number not found',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-404',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-3',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Sender number not found',
    });
  });

  test('should return 400 when the conversation sender does not match', async () => {
    sendSmsSpy.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'sender_mismatch',
      detail: 'Conversation sender does not match fromPhoneNumberId',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        conversationId: 'conversation-1',
        body: 'Hello there',
        idempotencyKey: 'sms-mismatch',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Conversation sender does not match fromPhoneNumberId',
    });
  });

  test('should return 409 when the recipient is suppressed', async () => {
    const message = buildMessage({
      status: 'FAILED',
      failureCode: 'recipient_suppressed',
      failureReason: 'Inbound STOP keyword',
      sentAt: null,
      failedAt: '2026-04-02T12:00:00.000Z',
    });
    sendSmsSpy.mockResolvedValueOnce({
      outcome: 'suppressed',
      conversationId: 'conversation-1',
      message,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-4',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Conflict',
      message: 'Recipient is suppressed for this sender',
      conversationId: 'conversation-1',
      messageRecord: message,
    });
  });

  test('should return 422 for provider rejections', async () => {
    sendSmsSpy.mockResolvedValueOnce({
      outcome: 'provider_rejected',
      conversationId: 'conversation-1',
      message: buildMessage({ status: 'REJECTED', failureCode: '21614' }),
      reason: 'Non White-listed Destination - rejected',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-5',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'Unprocessable Entity',
      message: 'Non White-listed Destination - rejected',
      conversationId: 'conversation-1',
      messageRecord: { status: 'REJECTED' },
    });
  });

  test('should return 502 for provider transport failures', async () => {
    sendSmsSpy.mockResolvedValueOnce({
      outcome: 'provider_failed',
      conversationId: 'conversation-1',
      message: buildMessage({
        status: 'FAILED',
        failureCode: 'provider_transport_error',
      }),
      reason: 'Twilio Messages API returned invalid JSON',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-6',
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: 'Bad Gateway',
      message: 'Twilio Messages API returned invalid JSON',
    });
  });

  test('should return 500 for unexpected service errors', async () => {
    sendSmsSpy.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-unexpected',
      },
    });

    expect(response.statusCode).toBe(500);
  });

  test('should return 200 for idempotent replays', async () => {
    const message = buildMessage({
      status: 'FAILED',
      failureCode: 'provider_transport_error',
      failureReason: 'Twilio Messages API returned invalid JSON',
      sentAt: null,
      failedAt: '2026-04-02T12:00:00.000Z',
    });
    sendSmsSpy.mockResolvedValueOnce({
      outcome: 'deduplicated',
      conversationId: 'conversation-1',
      message,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Hello there',
        idempotencyKey: 'sms-7',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      conversationId: 'conversation-1',
      message,
      deduplicated: true,
    });
  });

  test('should send a valid MMS payload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/mms',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        body: 'Photo',
        attachmentIds: ['prepared-1'],
        idempotencyKey: 'mms-1',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      message: { channel: 'MMS', attachments: [{ id: 'media-1' }] },
      deduplicated: false,
    });
    expect(sendMmsSpy).toHaveBeenCalledWith('user-1', {
      fromPhoneNumberId: 'phone-1',
      to: CONTACT_NUMBER,
      body: 'Photo',
      attachmentIds: ['prepared-1'],
      idempotencyKey: 'mms-1',
    });
  });

  test('should return 404 when an MMS sender cannot be used', async () => {
    sendMmsSpy.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'sender_not_found',
      detail: 'Sender number not found',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mms',
      payload: {
        fromPhoneNumberId: 'phone-404',
        to: CONTACT_NUMBER,
        body: 'Photo',
        attachmentIds: ['prepared-1'],
        idempotencyKey: 'mms-2',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Sender number not found',
    });
  });

  test('should return 400 when the MMS attachment cannot be used', async () => {
    sendMmsSpy.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'attachment_unavailable',
      detail: 'Prepared media has expired',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/mms',
      payload: {
        fromPhoneNumberId: 'phone-1',
        to: CONTACT_NUMBER,
        attachmentIds: ['prepared-1'],
        idempotencyKey: 'mms-3',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Prepared media has expired',
    });
  });

  test('should request a prepared media upload slot', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/media/uploads',
      payload: {
        fileName: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 128000,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(requestUploadSlotSpy).toHaveBeenCalledWith('user-1', {
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 128000,
    });
  });

  test('should reject oversized upload slot requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/media/uploads',
      payload: {
        fileName: 'image.png',
        mimeType: 'image/png',
        sizeBytes: 700000,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(requestUploadSlotSpy).not.toHaveBeenCalled();
  });

  test('should upload prepared media bytes', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/media/uploads/prepared-1?token=token-1',
      headers: {
        'content-type': 'image/png',
      },
      payload: Buffer.from('png-bytes'),
    });

    expect(response.statusCode).toBe(204);
    expect(uploadPreparedMediaSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedMediaId: 'prepared-1',
        token: 'token-1',
        contentType: 'image/png',
        body: Buffer.from('png-bytes'),
      }),
    );
  });

  test('should map media errors to their status codes on upload', async () => {
    uploadPreparedMediaSpy.mockRejectedValueOnce(
      new MessagingMediaError(
        'not_found',
        'Prepared media upload slot not found',
      ),
    );

    const response = await app.inject({
      method: 'PUT',
      url: '/media/uploads/prepared-404?token=token-1',
      headers: {
        'content-type': 'image/png',
      },
      payload: Buffer.from('png-bytes'),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Prepared media upload slot not found',
    });
  });

  test('should complete a prepared media upload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/media/uploads/prepared-1/complete',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(completeUploadSpy).toHaveBeenCalledWith('user-1', 'prepared-1');
  });

  test('should report an expired slot when completing an upload', async () => {
    completeUploadSpy.mockRejectedValueOnce(
      new MessagingMediaError(
        'expired',
        'Prepared media upload slot has expired',
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/media/uploads/prepared-1/complete',
      payload: {},
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({
      error: 'Gone',
      message: 'Prepared media upload slot has expired',
    });
  });
});

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    direction: 'OUTBOUND',
    channel: 'SMS',
    status: 'ACCEPTED',
    body: 'Hello there',
    from: SENDER_NUMBER,
    to: CONTACT_NUMBER,
    failureCode: null,
    failureReason: null,
    sentAt: '2026-04-02T12:00:00.000Z',
    deliveredAt: null,
    failedAt: null,
    createdAt: '2026-04-02T12:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}
