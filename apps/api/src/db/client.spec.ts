import { describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';

/**
 * The factory only builds the adapter — Prisma connects lazily on the first
 * query — so this can assert the wiring without a running database.
 */
describe('createDatabase', () => {
  it('builds a client with the default pool size', async () => {
    const db = createDatabase({ connectionString: 'postgresql://u:p@127.0.0.1:1/db' });
    expect(db).toBeDefined();
    expect(typeof db.$disconnect).toBe('function');
    await db.$disconnect();
  });

  it('accepts an explicit pool size', async () => {
    const db = createDatabase({
      connectionString: 'postgresql://u:p@127.0.0.1:1/db',
      maxConnections: 3,
    });
    expect(db).toBeDefined();
    await db.$disconnect();
  });
});
