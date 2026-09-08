import path from 'node:path';

/**
 * Shared Vitest settings for every workspace. Spread into each workspace's
 * vitest.config.ts. Kept free of vitest imports so the repository root does
 * not need vitest installed.
 *
 * Isolation is the point: each test file runs in its own process with a fresh
 * module graph, and every mock, spy, stubbed env var, and stubbed global is
 * reset before each test. Nothing set up in one test can leak into the next.
 */
export const sharedTestConfig = {
  environment: 'node' as const,
  pool: 'forks' as const,
  isolate: true,
  clearMocks: true,
  mockReset: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
  setupFiles: [path.join(import.meta.dirname, 'vitest.setup.ts')],
};
