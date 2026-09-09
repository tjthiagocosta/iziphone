import type { FastifyBaseLogger } from 'fastify';
import { vi } from 'vitest';

/** A pino-shaped logger whose methods are mocks; `vi.mocked(log.warn)` reads them. */
export function createFakeLogger(): FastifyBaseLogger {
  const log = {
    level: 'silent',
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: () => log,
  };
  return log as unknown as FastifyBaseLogger;
}
