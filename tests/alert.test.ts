/**
 * Telegram alerting: payload shape, HTML escaping, never-throw contract and
 * the 20/minute in-process rate limit. fetch is always mocked; no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertResult } from '../collector/alert.js';
import type { Deal } from '../collector/types.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

interface MockCall {
  url: string;
  init: RequestInit | undefined;
}

interface TelegramPayload {
  chat_id?: string;
  text?: string;
  parse_mode?: string;
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

function callAt(calls: MockCall[], index: number): MockCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`expected fetch call #${index}`);
  return call;
}

function requestBody(call: MockCall): TelegramPayload {
  const raw = call.init?.body;
  if (typeof raw !== 'string') throw new Error('request body was not a string');
  return JSON.parse(raw) as TelegramPayload;
}

function telegramOk(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: 7,
    vendor_id: 1,
    source_id: 1,
    title: 'Cursor Pro — 50% off annual',
    summary: null,
    price_now: 96,
    price_was: 192,
    currency: 'usd',
    discount_pct: 50,
    promo_code: 'BF26',
    starts_at: null,
    ends_at: new Date('2026-11-27T18:00:00.000Z'), // 28 Nov 00:00 in UTC+6
    url: 'https://cursor.com/pricing',
    eligibility_note: 'new customers only',
    confidence: 0.9,
    status: 'published',
    score: 12,
    score_breakdown: null,
    fingerprint: 'abc',
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    ...overrides,
  };
}

// A fresh module per test, so the rate-limit window starts empty; the clock is
// frozen so the rolling window is deterministic.
let notify!: (deal: Deal, vendorName: string) => Promise<AlertResult>;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../collector/alert.js');
  notify = mod.notify;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-20T12:00:00.000Z'));
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_CHAT_ID', '12345');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('telegram notify', () => {
  it('sends vendor, title, prices, discount, code, ends-at, eligibility and URL as HTML', async () => {
    const { calls } = mockFetch(async () => telegramOk());

    const result = await notify(makeDeal(), 'Cursor');

    expect(result).toEqual({ status: 'sent' });
    expect(calls).toHaveLength(1);
    expect(callAt(calls, 0).url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    expect(callAt(calls, 0).init?.method).toBe('POST');

    const payload = requestBody(callAt(calls, 0));
    expect(payload.chat_id).toBe('12345');
    expect(payload.parse_mode).toBe('HTML');

    const text = payload.text ?? '';
    expect(text).toContain('🔥 <b>Cursor</b>');
    expect(text).toContain('Cursor Pro — 50% off annual');
    expect(text).toContain('Price: USD 96.00 (was USD 192.00) · 50% off');
    expect(text).toContain('Code: <code>BF26</code>');
    expect(text).toContain('Ends: 28 Nov 2026, 00:00 (UTC+6)');
    expect(text).toContain('Eligibility: new customers only');
    expect(text).toContain('https://cursor.com/pricing');
  });

  it("escapes HTML in every interpolated value: title '<script>x</script>' cannot inject markup", async () => {
    const { calls } = mockFetch(async () => telegramOk());

    const result = await notify(
      makeDeal({
        title: '<script>x</script>',
        promo_code: 'A<B>',
        eligibility_note: '<b>new</b> only',
        url: 'https://example.com/?a=1&b=<2>',
      }),
      '<Vendor & Co>',
    );

    expect(result.status).toBe('sent');
    const text = requestBody(callAt(calls, 0)).text ?? '';
    expect(text).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;Vendor &amp; Co&gt;');
    expect(text).toContain('<code>A&lt;B&gt;</code>');
    expect(text).toContain('&lt;b&gt;new&lt;/b&gt; only');
    expect(text).toContain('a=1&amp;b=&lt;2&gt;');
  });

  it('caps sends at 20 per minute, then frees the window a minute later', async () => {
    const { fn } = mockFetch(async () => telegramOk());

    for (let i = 0; i < 20; i += 1) {
      await expect(notify(makeDeal({ id: i }), 'Cursor')).resolves.toEqual({ status: 'sent' });
    }
    await expect(notify(makeDeal(), 'Cursor')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('rate limit') as unknown,
    });
    expect(fn).toHaveBeenCalledTimes(20);

    vi.setSystemTime(new Date('2026-11-20T12:01:01.000Z'));
    await expect(notify(makeDeal(), 'Cursor')).resolves.toEqual({ status: 'sent' });
    expect(fn).toHaveBeenCalledTimes(21);
  });

  it('never throws: a network failure becomes a failed result', async () => {
    mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(notify(makeDeal(), 'Cursor')).resolves.toMatchObject({
      status: 'failed',
      error: 'ECONNREFUSED',
    });
  });

  it('never throws: a non-2xx response becomes a failed result', async () => {
    mockFetch(async () => new Response('bad gateway', { status: 500 }));

    await expect(notify(makeDeal(), 'Cursor')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('HTTP 500') as unknown,
    });
  });

  it("never throws: Telegram's own ok:false becomes a failed result", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );

    const result = await notify(makeDeal(), 'Cursor');

    expect(result.status).toBe('failed');
    expect(result.error).toContain('chat not found');
  });

  it('fails cleanly when TELEGRAM_BOT_TOKEN is missing, without calling the API', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const { fn } = mockFetch(async () => telegramOk());

    await expect(notify(makeDeal(), 'Cursor')).resolves.toMatchObject({
      status: 'failed',
      error: 'TELEGRAM_BOT_TOKEN is not set',
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('fails cleanly when TELEGRAM_CHAT_ID is missing, without calling the API', async () => {
    vi.stubEnv('TELEGRAM_CHAT_ID', '');
    const { fn } = mockFetch(async () => telegramOk());

    await expect(notify(makeDeal(), 'Cursor')).resolves.toMatchObject({
      status: 'failed',
      error: 'TELEGRAM_CHAT_ID is not set',
    });
    expect(fn).not.toHaveBeenCalled();
  });
});
