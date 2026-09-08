import { afterAll } from 'vitest';

// Tests assign process.env directly. Restore the original environment after
// each file so a worker that runs several files never carries values across.
const originalEnv = { ...process.env };

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});
