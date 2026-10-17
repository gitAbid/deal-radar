import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdapterContext, Source, Vendor } from '../collector/types.js';

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

export function makeVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: 1,
    slug: 'test-vendor',
    name: 'Test Vendor',
    category: 'devtools',
    tier: 1,
    website: null,
    service_line: null,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 1,
    vendor_id: 1,
    url: 'https://example.com/feed',
    kind: 'rss',
    adapter: 'rss',
    cadence_minutes: 15,
    enabled: true,
    note: null,
    last_checked_at: null,
    last_changed_at: null,
    content_hash: null,
    consecutive_failures: 0,
    health: 'ok',
    ...overrides,
  };
}

/** The default fetcher throws: adapters must work from `body` alone. */
export function makeContext(overrides: Partial<AdapterContext> & { body: string }): AdapterContext {
  const { body, ...rest } = overrides;
  return {
    vendor: rest.vendor ?? makeVendor(),
    source: rest.source ?? makeSource(),
    body,
    fetcher: rest.fetcher ?? {
      async fetch() {
        throw new Error('adapter performed an unexpected fetch');
      },
    },
    dryRun: rest.dryRun ?? false,
  };
}
