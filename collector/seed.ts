/**
 * `pnpm seed` — upsert every vendor and source from watchlist.yaml.
 *
 * Idempotent by construction: vendors conflict on slug, sources on
 * (vendor_id, url), and nothing is deleted. Re-running seed after editing the
 * watchlist is always safe.
 */

import { isMainModule, loadEnv, requireEnv } from './env.js';
import { createPool, createStore, type Store } from './store.js';
import { loadWatchlist, sourcesFromWatchlist, vendorFromWatchlist } from './watchlist.js';
import type { Watchlist } from './types.js';

export interface SeedResult {
  vendors: number;
  sources: number;
}

export async function seedWatchlist(store: Store, watchlist: Watchlist): Promise<SeedResult> {
  let vendors = 0;
  let sources = 0;
  for (const entry of watchlist.vendors) {
    const vendor = await store.upsertVendor(vendorFromWatchlist(entry));
    if (vendor.id === undefined) {
      throw new Error(`upsertVendor returned no id for slug "${entry.slug}"`);
    }
    vendors += 1;
    for (const source of sourcesFromWatchlist(entry)) {
      await store.upsertSource(vendor.id, source);
      sources += 1;
    }
  }
  return { vendors, sources };
}

async function main(): Promise<void> {
  loadEnv();
  const watchlist = loadWatchlist();
  const pool = createPool(requireEnv('DATABASE_URL'));
  try {
    const result = await seedWatchlist(createStore(pool), watchlist);
    const { rows } = await pool.query<{ vendors: number; sources: number }>(
      `SELECT (SELECT count(*)::int FROM vendor) AS vendors,
              (SELECT count(*)::int FROM source) AS sources`,
    );
    console.log(
      `seed: upserted ${result.vendors} vendors and ${result.sources} sources from watchlist.yaml`,
    );
    console.log(
      `seed: vendor table now has ${rows[0]?.vendors} rows, source table ${rows[0]?.sources} rows`,
    );
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('seed failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
