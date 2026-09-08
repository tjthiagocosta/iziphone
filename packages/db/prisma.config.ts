import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// All services read the repository-root .env (see README). Prisma 7 no longer
// loads .env files itself, so load it here before the config is evaluated.
config({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Left undefined for commands that do not need a database (e.g. generate).
    url: process.env.DATABASE_URL,
  },
});
