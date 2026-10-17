import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchError, createFetcher } from '../collector/fetcher.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function textResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

interface MockCall {
  url: string;
  init: RequestInit | undefined;
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: MockCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

function fetcher(config: Partial<Parameters<typeof createFetcher>[0]> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const now = vi.fn(() => 0);
  return {
    sleep,
    now,
    instance: createFetcher({
      minIntervalMs: 0,
      backoffMs: [250, 1000, 4000],
      robotsTtlMs: 60_000,
      sleep,
      now,
      ...config,
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('plain fetches', () => {
  it('returns the body, a SHA-256 hash and changed=true with no cache', async () => {
    const { calls } = mockFetch(async () => textResponse(200, 'hello world'));
    const { instance } = fetcher();

    const result = await instance.fetch('https://example.com/feed');

    expect(result).toMatchObject({ status: 200, body: 'hello world', hash: sha('hello world'), changed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.com/feed');
  });

  it('sends an identifiable User-Agent', async () => {
    const { calls } = mockFetch(async () => textResponse(200, 'x'));
    const { instance } = fetcher({ userAgent: 'DealRadar/1.0 (+https://example.com)' });
    await instance.fetch('https://example.com/feed');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('DealRadar/1.0 (+https://example.com)');
  });

  it('reports changed=false when the caller-supplied hash matches', async () => {
    mockFetch(async () => textResponse(200, 'same'));
    const { instance } = fetcher();
    const result = await instance.fetch('https://example.com/feed', { cache: { hash: sha('same') } });
    expect(result.changed).toBe(false);
  });

  it('reports changed=true when the caller-supplied hash differs', async () => {
    mockFetch(async () => textResponse(200, 'new content'));
    const { instance } = fetcher();
    const result = await instance.fetch('https://example.com/feed', { cache: { hash: sha('old content') } });
    expect(result.changed).toBe(true);
  });

  it('sends validators when supplied and treats 304 as unchanged', async () => {
    const { calls } = mockFetch(async () => textResponse(304));
    const { instance } = fetcher();

    const result = await instance.fetch('https://example.com/feed', {
      cache: { etag: 'W/"abc"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT', hash: sha('cached') },
    });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
    expect(headers['If-Modified-Since']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(result).toMatchObject({ status: 304, body: '', changed: false, hash: sha('cached') });
  });

  it('sends no conditional headers without a cache', async () => {
    const { calls } = mockFetch(async () => textResponse(200, 'x'));
    const { instance } = fetcher();
    await instance.fetch('https://example.com/feed');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['If-None-Match']).toBeUndefined();
    expect(headers['If-Modified-Since']).toBeUndefined();
  });
});

describe('errors and retries', () => {
  it('never retries a 4xx and throws FetchError with the status', async () => {
    const { fn } = mockFetch(async () => textResponse(404, 'nope'));
    const { instance, sleep } = fetcher();

    await expect(instance.fetch('https://example.com/gone')).rejects.toBeInstanceOf(FetchError);
    await expect(instance.fetch('https://example.com/gone')).rejects.toMatchObject({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(2); // one per fetch call, no retry
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries 5xx three times with 250ms then 1s backoff, then succeeds', async () => {
    let n = 0;
    const { fn } = mockFetch(async () => {
      n += 1;
      return n < 3 ? textResponse(503) : textResponse(200, 'ok');
    });
    const { instance, sleep } = fetcher();

    const result = await instance.fetch('https://example.com/flaky');

    expect(result.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 1000]);
  });

  it('gives up after three attempts on persistent 5xx', async () => {
    const { fn } = mockFetch(async () => textResponse(500));
    const { instance } = fetcher();

    await expect(instance.fetch('https://example.com/down')).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries network failures and reports status 0 when exhausted', async () => {
    const { fn } = mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const { instance, sleep } = fetcher();

    await expect(instance.fetch('https://example.com/unreachable')).rejects.toMatchObject({
      status: 0,
      name: 'FetchError',
    });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([250, 1000]);
  });
});

describe('robots.txt', () => {
  const ROBOTS = 'User-agent: *\nDisallow: /private\nAllow: /private/ok\n';

  it('refuses a disallowed page path without fetching it', async () => {
    const { calls } = mockFetch(async (url) =>
      url.endsWith('/robots.txt') ? textResponse(200, ROBOTS) : textResponse(200, 'page'),
    );
    const { instance } = fetcher();

    await expect(
      instance.fetch('https://example.com/private/secret', { kind: 'page' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/robots.txt']);
  });

  it('allows a path the robots file does not disallow', async () => {
    mockFetch(async (url) =>
      url.endsWith('/robots.txt') ? textResponse(200, ROBOTS) : textResponse(200, 'page'),
    );
    const { instance } = fetcher();
    const result = await instance.fetch('https://example.com/pricing', { kind: 'page' });
    expect(result.status).toBe(200);
  });

  it('allows the fetch when robots.txt is unreachable', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/robots.txt')) throw new TypeError('fetch failed');
      return textResponse(200, 'page');
    });
    const { instance } = fetcher();
    const result = await instance.fetch('https://example.com/pricing', { kind: 'page' });
    expect(result.status).toBe(200);
  });

  it('does not check robots.txt for rss/api sources', async () => {
    const { calls } = mockFetch(async () => textResponse(200, 'feed'));
    const { instance } = fetcher();
    await instance.fetch('https://example.com/private/feed.rss', { kind: 'rss' });
    expect(calls.map((c) => c.url)).toEqual(['https://example.com/private/feed.rss']);
  });

  it('caches robots.txt per host', async () => {
    const { calls } = mockFetch(async (url) =>
      url.endsWith('/robots.txt') ? textResponse(200, ROBOTS) : textResponse(200, 'page'),
    );
    const { instance } = fetcher();
    await instance.fetch('https://example.com/a', { kind: 'page' });
    await instance.fetch('https://example.com/b', { kind: 'page' });
    expect(calls.filter((c) => c.url.endsWith('/robots.txt'))).toHaveLength(1);
  });
});

describe('politeness', () => {
  it('waits out the per-domain minimum interval', async () => {
    mockFetch(async () => textResponse(200, 'x'));
    const { instance, sleep, now } = fetcher({ minIntervalMs: 1000 });
    await instance.fetch('https://example.com/one');
    await instance.fetch('https://example.com/two');
    expect(now).toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('does not delay requests to different domains', async () => {
    mockFetch(async () => textResponse(200, 'x'));
    const { instance, sleep } = fetcher({ minIntervalMs: 1000 });
    await instance.fetch('https://a.example.com/one');
    await instance.fetch('https://b.example.com/two');
    expect(sleep).not.toHaveBeenCalled();
  });
});
