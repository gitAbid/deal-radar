/**
 * A1 smoke check: proves the `pg` client can reach the database and that the
 * schema has been applied. Run: `pnpm exec tsx collector/smoke.ts`
 *
 * Not part of the collector; it exists so a broken DATABASE_URL fails loudly
 * here rather than halfway through a run.
 */

import pg from 'pg';
import { loadEnv, requireEnv } from './env.js';

const { Pool } = pg;

async function main(): Promise<void> {
  loadEnv();
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL'), max: 1 });
  try {
    const one = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    console.log('smoke: SELECT 1 →', one.rows[0]?.ok);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    console.log('smoke: public tables →', tables.rows.map((r) => r.table_name).join(', '));

    const vendors = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM vendor');
    console.log('smoke: vendor rows →', vendors.rows[0]?.n);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('smoke failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
