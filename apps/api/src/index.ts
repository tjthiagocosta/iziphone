import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { buildApp } from './app.js';
import { loadApiConfig } from './config.js';

loadDotenv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

const config = loadApiConfig(process.env);
const app = await buildApp(config);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ error }, 'Shutdown failed');
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen(config.listen);
} catch (error) {
  app.log.error({ error }, 'Failed to start');
  process.exit(1);
}
