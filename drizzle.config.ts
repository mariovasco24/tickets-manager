import { defineConfig } from 'drizzle-kit';

// Solo para generar migraciones: pnpm db:generate
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_PATH ?? './data/bugs-manager.db' },
});
