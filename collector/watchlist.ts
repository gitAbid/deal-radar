/**
 * watchlist.yaml → validated Vendor/Source records.
 *
 * The file is hand-edited and grew by copy-paste, so every failure here names
 * the offending line. No zod: the shape is small and fixed, and hand checks
 * are what produce line numbers.
 *
 * `dueSources(now)` lives in SQL (store.listDueSources) because cadence is a
 * property of the stored row, not of this file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parseDocument, type Node } from 'yaml';
import type {
  AdapterName,
  Category,
  Source,
  SourceKind,
  Vendor,
  Watchlist,
  WatchlistSource,
  WatchlistVendor,
} from './types.js';

export const CATEGORIES: readonly Category[] = ['llm', 'media', 'devtools', 'hosting', 'ops', 'storage'];
export const SOURCE_KINDS: readonly SourceKind[] = ['rss', 'api', 'page'];
export const ADAPTERS: readonly AdapterName[] = ['rss', 'hackernews', 'reddit', 'llm_page'];

/** Each adapter reads exactly one kind of source. Catches copy-paste mistakes. */
export const ADAPTER_KIND: Readonly<Record<AdapterName, SourceKind>> = {
  rss: 'rss',
  hackernews: 'api',
  reddit: 'api',
  llm_page: 'page',
};

export const TIER_CADENCE_MINUTES: Readonly<Record<1 | 2, number>> = { 1: 15, 2: 360 };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const defaultWatchlistPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'watchlist.yaml',
);

export class WatchlistError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
  ) {
    super(`${file}:${line}: ${message}`);
    this.name = 'WatchlistError';
  }
}

export function loadWatchlist(path: string = defaultWatchlistPath): Watchlist {
  const text = readFileSync(path, 'utf8');
  const doc = parseDocument(text);
  const parseError = doc.errors[0];
  if (parseError) {
    throw new WatchlistError(`${parseError.message}`, path, parseError.linePos?.[0]?.line ?? 1);
  }

  const raw = doc.toJS() as unknown;
  if (!isRecord(raw)) throw new WatchlistError('top level must be a mapping', path, 1);

  const vendorsValue = raw['vendors'];
  if (!Array.isArray(vendorsValue) || vendorsValue.length === 0) {
    throw new WatchlistError('`vendors` must be a non-empty list', path, 1);
  }
  const vendorsNode: unknown = doc.get('vendors', true);

  const vendors: WatchlistVendor[] = [];
  const seenSlugs = new Set<string>();

  vendorsValue.forEach((entry: unknown, index: number) => {
    const node = seqItem(vendorsNode, index);
    const line = lineOf(text, node);
    if (!isRecord(entry)) throw new WatchlistError(`vendors[${index}] must be a mapping`, path, line);

    const slug = expectString(entry['slug'], `vendors[${index}].slug`, path, line);
    if (!SLUG_PATTERN.test(slug)) {
      throw new WatchlistError(
        `vendors[${index}].slug "${slug}" must be lowercase kebab-case`,
        path,
        line,
      );
    }
    if (seenSlugs.has(slug)) {
      throw new WatchlistError(`duplicate vendor slug "${slug}"`, path, line);
    }
    seenSlugs.add(slug);

    const name = expectString(entry['name'], `vendors[${index}].name`, path, line);
    const category = entry['category'];
    if (!CATEGORIES.includes(category as Category)) {
      throw new WatchlistError(
        `vendors[${index}].category must be one of ${CATEGORIES.join(', ')} (got ${JSON.stringify(category)})`,
        path,
        line,
      );
    }
    const tier = entry['tier'];
    if (tier !== 1 && tier !== 2) {
      throw new WatchlistError(`vendors[${index}].tier must be 1 or 2`, path, line);
    }

    const vendor: WatchlistVendor = { slug, name, category: category as Category, tier };
    if (entry['website'] !== undefined) {
      vendor.website = expectString(entry['website'], `vendors[${index}].website`, path, line);
    }
    if (entry['service_line'] !== undefined) {
      vendor.service_line = expectString(
        entry['service_line'],
        `vendors[${index}].service_line`,
        path,
        line,
      );
    }

    const sourcesValue = entry['sources'];
    if (sourcesValue !== undefined) {
      if (!Array.isArray(sourcesValue)) {
        throw new WatchlistError(`vendors[${index}].sources must be a list`, path, line);
      }
      const sourcesNode = mapGet(node, 'sources');
      const seenUrls = new Set<string>();

      vendor.sources = sourcesValue.map((sourceEntry: unknown, sIndex: number) => {
        const sourceNode = seqItem(sourcesNode, sIndex);
        const sLine = lineOf(text, sourceNode) ?? line;
        const where = `vendors[${index}].sources[${sIndex}]`;
        if (!isRecord(sourceEntry)) throw new WatchlistError(`${where} must be a mapping`, path, sLine);

        const url = expectString(sourceEntry['url'], `${where}.url`, path, sLine);
        assertHttpUrl(url, where, path, sLine);
        if (seenUrls.has(url)) throw new WatchlistError(`duplicate source url "${url}"`, path, sLine);
        seenUrls.add(url);

        const kind = sourceEntry['kind'];
        if (!SOURCE_KINDS.includes(kind as SourceKind)) {
          throw new WatchlistError(
            `${where}.kind must be one of ${SOURCE_KINDS.join(', ')} (got ${JSON.stringify(kind)})`,
            path,
            sLine,
          );
        }
        const adapter = sourceEntry['adapter'];
        if (!ADAPTERS.includes(adapter as AdapterName)) {
          throw new WatchlistError(
            `${where}.adapter must be one of ${ADAPTERS.join(', ')} (got ${JSON.stringify(adapter)})`,
            path,
            sLine,
          );
        }
        if (ADAPTER_KIND[adapter as AdapterName] !== kind) {
          throw new WatchlistError(
            `${where}: adapter "${String(adapter)}" requires kind "${ADAPTER_KIND[adapter as AdapterName]}" (got "${String(kind)}")`,
            path,
            sLine,
          );
        }

        const source: WatchlistSource = {
          url,
          kind: kind as SourceKind,
          adapter: adapter as AdapterName,
        };
        const cadence = sourceEntry['cadence_minutes'];
        if (cadence !== undefined) {
          if (typeof cadence !== 'number' || !Number.isInteger(cadence) || cadence <= 0) {
            throw new WatchlistError(`${where}.cadence_minutes must be a positive integer`, path, sLine);
          }
          source.cadence_minutes = cadence;
        }
        const enabled = sourceEntry['enabled'];
        if (enabled !== undefined) {
          if (typeof enabled !== 'boolean') {
            throw new WatchlistError(`${where}.enabled must be a boolean`, path, sLine);
          }
          source.enabled = enabled;
        }
        const note = sourceEntry['note'];
        if (note !== undefined) {
          source.note = expectString(note, `${where}.note`, path, sLine);
        }
        return source;
      });
    }

    vendors.push(vendor);
  });

  return { vendors };
}

export function cadenceForTier(tier: 1 | 2): number {
  return TIER_CADENCE_MINUTES[tier];
}

export function vendorFromWatchlist(entry: WatchlistVendor): Vendor {
  return {
    slug: entry.slug,
    name: entry.name,
    category: entry.category,
    tier: entry.tier,
    website: entry.website ?? null,
    service_line: entry.service_line ?? null,
  };
}

export function sourcesFromWatchlist(
  entry: WatchlistVendor,
): Array<Omit<Source, 'id' | 'vendor_id'>> {
  return (entry.sources ?? []).map((source) => {
    const enabled = source.enabled ?? true;
    return {
      url: source.url,
      kind: source.kind,
      adapter: source.adapter,
      cadence_minutes: source.cadence_minutes ?? cadenceForTier(entry.tier),
      enabled,
      note: source.note ?? null,
      last_checked_at: null,
      last_changed_at: null,
      content_hash: null,
      consecutive_failures: 0,
      health: enabled ? 'ok' : 'disabled',
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, where: string, path: string, line: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WatchlistError(`${where} must be a non-empty string`, path, line);
  }
  return value.trim();
}

function assertHttpUrl(url: string, where: string, path: string, line: number): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WatchlistError(`${where}.url "${url}" is not a valid URL`, path, line);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WatchlistError(`${where}.url must be http(s)`, path, line);
  }
}

function seqItem(seq: unknown, index: number): Node | undefined {
  return isSeq(seq) ? (seq.items[index] as Node | undefined) : undefined;
}

function mapGet(map: unknown, key: string): unknown {
  return isMap(map) ? map.get(key, true) : undefined;
}

function lineOf(text: string, node: Node | undefined): number {
  const range = node?.range;
  if (!range) return 1;
  return text.slice(0, range[0]).split('\n').length;
}
