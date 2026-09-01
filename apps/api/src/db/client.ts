import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client.js';

export type Database = PrismaClient;

export interface CreateDatabaseOptions {
  connectionString: string;
  /** Upper bound on pooled connections. Keep below Postgres `max_connections`. */
  maxConnections?: number;
}

/**
 * Build a Prisma client wired to node-postgres.
 *
 * A factory rather than a module-level singleton: the integration suite builds
 * one against the test database, and `main.ts` builds one against the real
 * database. Prisma 7 requires an explicit driver adapter — the connection
 * string no longer lives in the schema.
 */
export function createDatabase(options: CreateDatabaseOptions): Database {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
  });

  return new PrismaClient({ adapter, log: ['warn', 'error'] });
}
