/**
 * LLM extraction: mocked fetch only, recorded-shaped fixtures, no live calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEXT_LIMIT, extractDeals, htmlToText } from '../collector/extract.js';
import { fixture } from './helpers.js';

const BASE = 'https://llm.example/v1';
const JSON_HEADERS = { 'content-type': 'application/json' };

interface MockCall {
  url: string;
  init: RequestInit | undefined;
}

interface ChatRequestBody {
  model?: string;
  temperature?: number;
  response_format?: { type?: string };
  messages?: Array<{ role?: string; content?: string }>;
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

function requestBody(call: MockCall): ChatRequestBody {
  const raw = call.init?.body;
  if (typeof raw !== 'string') throw new Error('request body was not a string');
  return JSON.parse(raw) as ChatRequestBody;
}

function messageAt(body: ChatRequestBody, index: number): { role?: string; content?: string } {
  const message = body.messages?.[index];
  if (message === undefined) throw new Error(`expected message #${index}`);
  return message;
}

/** An OpenAI-compatible envelope around an arbitrary content string. */
function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    { status: 200, headers: JSON_HEADERS },
  );
}

/** The valid fixture file, as an HTTP Response. */
function fixtureResponse(name: string): Response {
  return new Response(fixture(name), { status: 200, headers: JSON_HEADERS });
}

/** The content string inside the valid fixture envelope. */
function validFixtureContent(): string {
  const parsed: unknown = JSON.parse(fixture('llm-response-valid.json'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('bad fixture');
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('bad fixture: choices');
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content !== 'string') throw new Error('bad fixture: content');
  return content;
}

const PAGE =
  '<html><body><h1>Cursor Black Friday</h1><script>analytics()</script>' +
  '<p>Pro annual &amp; monthly plans: was $192, now $96.</p></body></html>';

function stubLlmEnv(): void {
  vi.stubEnv('LLM_API_KEY', 'test-key');
  vi.stubEnv('LLM_BASE_URL', `${BASE}/`); // trailing slash must not double up
  vi.stubEnv('LLM_MODEL', 'test-model');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('htmlToText', () => {
  it('drops script/style content, decodes entities and keeps block structure', () => {
    const text = htmlToText(
      '<p>Hello &amp; welcome</p><script>evil()</script><style>.x{}</style><div>Line 2</div><p>1 &lt; 2</p>',
    );
    expect(text).toBe('Hello & welcome\nLine 2\n1 < 2');
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>&#8377; 1,999</p>')).toBe('₹ 1,999');
  });
});

describe('extractDeals', () => {
  it('refuses to run without LLM_API_KEY and never calls the API', async () => {
    vi.stubEnv('LLM_API_KEY', '');
    const { fn } = mockFetch(async () => completion('{}'));

    await expect(extractDeals(PAGE, { name: 'Cursor', category: 'devtools' })).rejects.toThrow(
      /LLM_API_KEY/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('parses a valid response, sends the stripped page text, and aggregates confidence as the minimum', async () => {
    stubLlmEnv();
    const { calls } = mockFetch(async () => fixtureResponse('llm-response-valid.json'));

    const result = await extractDeals(PAGE, { name: 'Cursor', category: 'devtools' });

    // One request to the OpenAI-compatible endpoint, with the API key.
    expect(calls).toHaveLength(1);
    const call = callAt(calls, 0);
    expect(call.url).toBe(`${BASE}/chat/completions`);
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.['authorization']).toBe('Bearer test-key');

    const body = requestBody(call);
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });

    const system = messageAt(body, 0);
    expect(system.role).toBe('system');
    expect(system.content).toContain('eligibility_note');

    // Vendor name and category are in the prompt; HTML is stripped.
    const user = messageAt(body, 1);
    expect(user.role).toBe('user');
    expect(user.content).toContain('Vendor: Cursor');
    expect(user.content).toContain('Category: devtools');
    expect(user.content).toContain('Pro annual & monthly plans: was $192, now $96.');
    expect(user.content).not.toContain('analytics()');

    // The fixture's deals carry 0.92 and 0.55: the aggregate is the minimum,
    // and every deal carries it so a shaky extraction cannot launder one deal.
    expect(result.repaired).toBe(false);
    expect(result.confidence).toBeCloseTo(0.55);
    expect(result.deals).toHaveLength(2);

    const [first, second] = result.deals;
    expect(first).toMatchObject({
      title: 'Cursor Pro — 50% off annual',
      price_now: 96,
      price_was: 192,
      currency: 'USD',
      discount_pct: 50,
      promo_code: 'BF26',
      starts_at: '2026-11-20T00:00:00Z',
      ends_at: '2026-11-27T23:59:59Z',
      url: 'https://cursor.com/pricing?ref=black-friday',
      eligibility_note: 'new customers only',
      confidence: 0.55,
    });
    expect(second).toMatchObject({
      title: 'Cursor Ultra — $100 off the first year',
      price_now: 200,
      price_was: 300,
      eligibility_note: 'annual plans only',
      confidence: 0.55,
    });
  });

  it('repairs invalid JSON exactly once, appending the error text, then succeeds', async () => {
    stubLlmEnv();
    let attempt = 0;
    const { calls } = mockFetch(async () => {
      attempt += 1;
      return attempt === 1 ? fixtureResponse('llm-response-malformed.json') : completion(validFixtureContent());
    });

    const result = await extractDeals(PAGE, { name: 'Cursor', category: 'devtools' });

    expect(calls).toHaveLength(2);
    expect(result.repaired).toBe(true);
    expect(result.deals).toHaveLength(2);

    // The repair request carries the conversation: system, user, the bad
    // assistant reply, then the error text.
    const repair = requestBody(callAt(calls, 1));
    expect(repair.messages).toHaveLength(4);
    expect(messageAt(repair, 2).role).toBe('assistant');
    expect(messageAt(repair, 3).role).toBe('user');
    expect(messageAt(repair, 3).content).toContain('was not valid JSON');
    expect(messageAt(repair, 3).content).toContain('rejected');
  });

  it('repairs a schema violation with the failing field named', async () => {
    stubLlmEnv();
    let attempt = 0;
    const { calls } = mockFetch(async () => {
      attempt += 1;
      return attempt === 1
        ? completion('{"deals":[{"summary":"no title here"}],"confidence":0.9}')
        : completion(validFixtureContent());
    });

    const result = await extractDeals(PAGE, { name: 'Cursor', category: 'devtools' });

    expect(calls).toHaveLength(2);
    expect(result.repaired).toBe(true);
    expect(messageAt(requestBody(callAt(calls, 1)), 3).content).toContain('deals[0].title');
  });

  it('treats an out-of-range confidence as a violation (no silent clamping)', async () => {
    stubLlmEnv();
    let attempt = 0;
    const { calls } = mockFetch(async () => {
      attempt += 1;
      return attempt === 1
        ? completion('{"deals":[{"title":"Shaky deal","confidence":95}],"confidence":0.9}')
        : completion(validFixtureContent());
    });

    const result = await extractDeals(PAGE, { name: 'Cursor', category: 'devtools' });

    expect(calls).toHaveLength(2);
    expect(result.repaired).toBe(true);
    expect(messageAt(requestBody(callAt(calls, 1)), 3).content).toContain('between 0 and 1');
  });

  it('throws after one failed repair — never more than two requests', async () => {
    stubLlmEnv();
    const { calls } = mockFetch(async () => fixtureResponse('llm-response-malformed.json'));

    await expect(extractDeals(PAGE, { name: 'Cursor', category: 'devtools' })).rejects.toThrow(
      /after one repair attempt/,
    );
    expect(calls).toHaveLength(2);
  });

  it('does not repair an HTTP failure', async () => {
    stubLlmEnv();
    const { calls } = mockFetch(
      async () => new Response('unauthorized', { status: 401, headers: JSON_HEADERS }),
    );

    await expect(extractDeals(PAGE, { name: 'Cursor', category: 'devtools' })).rejects.toThrow(
      /HTTP 401/,
    );
    expect(calls).toHaveLength(1);
  });

  it('returns an empty deal list when the vendor has no deals', async () => {
    stubLlmEnv();
    mockFetch(async () => completion('{"deals":[],"confidence":0.8}'));

    const result = await extractDeals(PAGE, { name: 'Cursor', category: 'devtools' });

    expect(result.deals).toEqual([]);
    expect(result.confidence).toBeCloseTo(0.8);
    expect(result.repaired).toBe(false);
  });

  it('truncates the page text to the limit with a marker', async () => {
    stubLlmEnv();
    const { calls } = mockFetch(async () => completion('{"deals":[],"confidence":0.9}'));
    const longPage = `<p>${'x'.repeat(TEXT_LIMIT + 3_000)}</p>`;

    await extractDeals(longPage, { name: 'Cursor', category: 'devtools' });

    const user = messageAt(requestBody(callAt(calls, 0)), 1);
    expect(user.content).toContain('[...truncated]');
    expect(user.content?.length ?? 0).toBeLessThan(TEXT_LIMIT + 500);
  });
});
