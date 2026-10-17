/**
 * Heartbeat: the dead-man's switch (spec §10). It must never throw, must not
 * call out when HEARTBEAT_URL is unset, and must survive a failing ping.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ping } from '../collector/heartbeat.js';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('heartbeat ping', () => {
  it('no-ops with a debug log when HEARTBEAT_URL is unset', async () => {
    vi.stubEnv('HEARTBEAT_URL', '');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { fn } = mockFetch(async () => new Response('', { status: 200 }));

    await expect(ping()).resolves.toBeUndefined();

    expect(fn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0]?.[0])).toContain('HEARTBEAT_URL');
  });

  it('GETs HEARTBEAT_URL exactly once when set', async () => {
    vi.stubEnv('HEARTBEAT_URL', 'https://hc.example.com/ping/abc');
    const { calls } = mockFetch(async () => new Response('OK', { status: 200 }));

    await expect(ping()).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hc.example.com/ping/abc');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('resolves when the network call fails', async () => {
    vi.stubEnv('HEARTBEAT_URL', 'https://hc.example.com/ping/abc');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(async () => {
      throw new Error('ENOTFOUND');
    });

    await expect(ping()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('ENOTFOUND');
  });

  it('resolves on a non-2xx ping response', async () => {
    vi.stubEnv('HEARTBEAT_URL', 'https://hc.example.com/ping/abc');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch(async () => new Response('nope', { status: 503 }));

    await expect(ping()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('503');
  });
});
