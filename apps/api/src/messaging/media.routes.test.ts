import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import { messageMediaRoutes } from './media.routes.js';
import { MessagingMediaError, MessagingMediaService } from './media.service.js';

describe('messageMediaRoutes', () => {
  let app: FastifyInstance;
  let openPreparedMediaSpy: ReturnType<typeof spyOn>;
  let openMessageMediaSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    openPreparedMediaSpy = vi
      .spyOn(MessagingMediaService.prototype, 'openPreparedMedia')
      .mockImplementation(async () => ({
        mimeType: 'image/png',
        sizeBytes: 9,
        content: Readable.from(Buffer.from('png-bytes')),
      }));
    openMessageMediaSpy = vi
      .spyOn(MessagingMediaService.prototype, 'openMessageMedia')
      .mockImplementation(async () => ({
        mimeType: 'application/pdf',
        sizeBytes: 9,
        content: Readable.from(Buffer.from('pdf-bytes')),
      }));

    app = await createApiRouteApp(messageMediaRoutes, { db: {}, user: null });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should serve prepared media with its content type', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/media/messaging/prepared/prepared-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['content-length']).toBe('9');
    expect(response.body).toBe('png-bytes');
    expect(openPreparedMediaSpy).toHaveBeenCalledWith('prepared-1');
  });

  test('should answer 410 for expired prepared media', async () => {
    openPreparedMediaSpy.mockRejectedValueOnce(
      new MessagingMediaError('expired', 'Prepared media has expired'),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/media/messaging/prepared/prepared-1',
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: 'Gone' });
  });

  test('should serve message media', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/media/messaging/messages/media-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.body).toBe('pdf-bytes');
    expect(openMessageMediaSpy).toHaveBeenCalledWith('media-1');
  });

  test('should answer 404 for unknown message media', async () => {
    openMessageMediaSpy.mockRejectedValueOnce(
      new MessagingMediaError('not_found', 'Message media not found'),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/media/messaging/messages/media-404',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Not Found' });
  });
});
