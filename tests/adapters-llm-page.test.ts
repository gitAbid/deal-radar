/**
 * llm_page adapter: fixture HTML in, mocked LLM out. No network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLlmPageAdapter } from '../collector/adapters/llm-page.js';
import { fixture, makeContext, makeVendor } from './helpers.js';

const PAGE =
  '<html><body><h1>Cursor Black Friday</h1><p>Pro annual $96 (was $192). Code BF26.</p></body></html>';

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

/** The user message sent to the model, parsed out of the request body. */
function promptText(call: MockCall): string {
  const raw = call.init?.body;
  if (typeof raw !== 'string') throw new Error('request body was not a string');
  const body = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> };
  const user = body.messages?.[1];
  if (user?.content === undefined) throw new Error('no user message in request');
  return user.content;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('llm_page adapter', () => {
  it('is named llm_page', () => {
    expect(createLlmPageAdapter().name).toBe('llm_page');
  });

  it('extracts RawDeals from the fetched body with the mocked LLM', async () => {
    vi.stubEnv('LLM_API_KEY', 'test-key');
    vi.stubEnv('LLM_BASE_URL', 'https://llm.example/v1');
    vi.stubEnv('LLM_MODEL', 'test-model');
    const { calls } = mockFetch(
      async () =>
        new Response(fixture('llm-response-valid.json'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const deals = await createLlmPageAdapter().fetchDeals(
      makeContext({ body: PAGE, vendor: makeVendor({ name: 'Cursor', category: 'devtools' }) }),
    );

    expect(calls).toHaveLength(1);
    // The page text came from ctx.body, not a re-fetch.
    expect(promptText(calls[0]!)).toContain('Pro annual $96 (was $192). Code BF26.');

    expect(deals).toHaveLength(2);
    expect(deals[0]).toMatchObject({
      title: 'Cursor Pro — 50% off annual',
      price_now: 96,
      price_was: 192,
      promo_code: 'BF26',
      eligibility_note: 'new customers only',
      // Aggregate (minimum) confidence, so the pipeline gate sees 0.55.
      confidence: 0.55,
    });
    expect(deals[1]).toMatchObject({
      title: 'Cursor Ultra — $100 off the first year',
      confidence: 0.55,
    });
  });

  it('propagates a failed extraction instead of pretending there were no deals', async () => {
    vi.stubEnv('LLM_API_KEY', '');
    mockFetch(async () => new Response('{}', { status: 200 }));

    await expect(
      createLlmPageAdapter().fetchDeals(makeContext({ body: PAGE })),
    ).rejects.toThrow(/LLM_API_KEY/);
  });
});
