import { Pool, types, type QueryResult, type QueryResultRow } from 'pg';

// node-postgres returns NUMERIC and BIGINT as strings by default (to preserve
// arbitrary precision). Every numeric column in db/schema.sql is comfortably
// inside float64 / Number.MAX_SAFE_INTEGER, so parse them once, globally,
// rather than mapping strings at every call site.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

// Next.js dev re-evaluates modules on change. Keep exactly one pool per
// process (module-level + globalThis guard) so hot reloads — and requests in
// production — never leak a pool per invocation.
declare global {
  // eslint-disable-next-line no-var
  var __dealRadarPool: Pool | undefined;
}

function getPool(): Pool {
  if (!globalThis.__dealRadarPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Add it to web/.env.local (or the Vercel project env vars). See web/README.md.',
      );
    }
    globalThis.__dealRadarPool = new Pool({
      connectionString,
      max: 3, // one dashboard instance; Neon's pooler multiplexes the rest
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true,
    });
  }
  return globalThis.__dealRadarPool;
}

export function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<R>> {
  return getPool().query<R>(text, params);
}
