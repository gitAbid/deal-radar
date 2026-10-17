/**
 * Polite HTTP: robots.txt for pages, per-domain rate limit, conditional
 * requests, content hashing, bounded retries.
 *
 * The collector polls ~100 sources on a schedule, so the point of this module
 * is to be a good citizen and to fail predictably:
 *   - pages respect robots.txt (cached per host; unreachable ⇒ allowed)
 *   - one request per second per domain by default
 *   - 5xx / network errors retry 3 times (250ms, 1s, 4s); 4xx never retries
 *   - 304 responses are free: body empty, changed=false
 *
 * `createFetcher` takes injectable `sleep`/`now` so tests never wait.
 */

import { createHash } from 'node:crypto';
import type { FetchResult, SourceKind } from './types.js';

export class FetchError extends Error {
  readonly url: string;
  readonly status: number;

  constructor(message: string, url: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
  }
}

export interface FetchCache {
  /** Caller-stored content hash, used to compute `changed`. */
  hash?: string | null;
  /** Only usable if the caller persists it out of band; the schema has no etag column. */
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchOptions {
  cache?: FetchCache;
  /** `page` fetches check robots.txt; `rss`/`api` do not. */
  kind?: SourceKind;
}

export interface Fetcher {
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}

export interface FetcherConfig {
  userAgent?: string;
  /** Minimum gap between requests to the same host. Default 1000ms. */
  minIntervalMs?: number;
  /** Per-attempt timeout. Default 15000ms. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Delay before each retry. Default [250, 1000, 4000]. */
  backoffMs?: number[];
  respectRobots?: boolean;
  robotsTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_USER_AGENT = 'DealRadar/1.0 (+https://github.com/gitAbid/deal-radar)';

interface RobotsRule {
  allow: boolean;
  path: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export function createFetcher(config: FetcherConfig = {}): Fetcher {
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const minIntervalMs = config.minIntervalMs ?? 1000;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const attempts = Math.max(1, config.attempts ?? 3);
  const backoffMs = config.backoffMs ?? [250, 1000, 4000];
  const respectRobots = config.respectRobots ?? true;
  const robotsTtlMs = config.robotsTtlMs ?? 3_600_000;
  const sleep = config.sleep ?? defaultSleep;
  const clock = config.now ?? (() => Date.now());

  const lastRequestAt = new Map<string, number>();
  const robotsCache = new Map<string, { expires: number; groups: RobotsGroup[] }>();

  async function waitForTurn(host: string): Promise<void> {
    const at = clock();
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = minIntervalMs - (at - last);
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, clock());
  }

  async function request(url: string, headers: Record<string, string>): Promise<Response> {
    await waitForTurn(new URL(url).host);
    return fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function robotsGroupsFor(origin: string): Promise<RobotsGroup[]> {
    const cached = robotsCache.get(origin);
    if (cached !== undefined && cached.expires > clock()) return cached.groups;

    let groups: RobotsGroup[] = [];
    try {
      const res = await request(`${origin}/robots.txt`, { 'User-Agent': userAgent });
      if (res.ok) groups = parseRobots(await res.text());
    } catch {
      groups = []; // unreachable robots.txt ⇒ allowed, per spec
    }
    robotsCache.set(origin, { expires: clock() + robotsTtlMs, groups });
    return groups;
  }

  return {
    async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
      if (respectRobots && options.kind === 'page') {
        const target = new URL(url);
        const groups = await robotsGroupsFor(target.origin);
        if (!isAllowed(groups, `${target.pathname}${target.search}`, userAgent)) {
          throw new FetchError(`robots.txt disallows ${url}`, url, 403);
        }
      }

      const cache = options.cache ?? {};
      const headers: Record<string, string> = { 'User-Agent': userAgent, Accept: '*/*' };
      if (cache.etag) headers['If-None-Match'] = cache.etag;
      if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;

      let lastError: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const res = await request(url, headers);

          if (res.status === 304) {
            return { status: 304, body: '', hash: cache.hash ?? '', changed: false };
          }

          if (!res.ok) {
            const error = new FetchError(`HTTP ${res.status} for ${url}`, url, res.status);
            if (res.status >= 500 && attempt < attempts - 1) {
              lastError = error;
              await retryPause(backoffMs[attempt], sleep);
              continue;
            }
            throw error;
          }

          const body = await res.text();
          const hash = sha256(body);
          return {
            status: res.status,
            body,
            hash,
            changed: cache.hash ? cache.hash !== hash : true,
          };
        } catch (error) {
          // A 4xx surfaced above is final: retrying a "no" is impolite.
          if (error instanceof FetchError && error.status < 500) throw error;
          lastError = error;
          if (attempt < attempts - 1) {
            await retryPause(backoffMs[attempt], sleep);
            continue;
          }
        }
      }

      throw toFetchError(lastError, url);
    },
  };
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function toFetchError(error: unknown, url: string): FetchError {
  if (error instanceof FetchError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FetchError(`Request failed for ${url}: ${message}`, url, 0, { cause: error });
}

async function retryPause(ms: number | undefined, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (ms !== undefined && ms > 0) await sleep(ms);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal robots.txt: user-agent groups, Disallow/Allow, longest match wins. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') {
      lastWasAgent = false;
      continue;
    }
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();

    if (field === 'user-agent') {
      if (current === null || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (current === null) continue;
    if (field === 'disallow') current.rules.push({ allow: false, path: value });
    else if (field === 'allow') current.rules.push({ allow: true, path: value });
  }

  return groups.filter((group) => group.agents.length > 0);
}

export function isAllowed(groups: RobotsGroup[], path: string, userAgent: string): boolean {
  const token = (userAgent.toLowerCase().split(/\s+/)[0] ?? '').split('/')[0] ?? '';
  const applicable = groups.filter((group) =>
    group.agents.some((agent) => agent === '*' || agent === token),
  );
  const matching = applicable
    .flatMap((group) => group.rules)
    .filter((rule) => rule.path !== '' && path.startsWith(rule.path));
  if (matching.length === 0) return true;

  matching.sort(
    (a, b) => b.path.length - a.path.length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1),
  );
  return matching[0]?.allow ?? true;
}
