/**
 * Dead-man's switch ping (spec §10 — "the single most important defence in
 * the system").
 *
 * GETs `HEARTBEAT_URL` when set; no-ops with a debug log when unset so a
 * missing defence is at least visible in the run log. It NEVER throws: the
 * switch exists to detect silence, not to become a new failure mode. A ping
 * that fails is logged, and the next run pings again.
 *
 * Provider-agnostic by design: any URL that raises an alert on silence works
 * (healthchecks.io, cronitor, a bespoke endpoint). If the URL is unset, this
 * defence is inactive and the /sources page is the only signal left — hence
 * the log line rather than a silent skip.
 */

import { env } from './env.js';

const REQUEST_TIMEOUT_MS = 10_000;

export async function ping(): Promise<void> {
  const url = env('HEARTBEAT_URL');
  if (url === undefined) {
    console.debug("[heartbeat] HEARTBEAT_URL is not set — dead-man's switch inactive");
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[heartbeat] ping returned HTTP ${res.status}`);
    }
  } catch (error) {
    console.warn(`[heartbeat] ping failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
