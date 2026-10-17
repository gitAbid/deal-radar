/**
 * Vendor page → LLM extraction adapter.
 *
 * A thin shim: extraction, validation and confidence aggregation all live in
 * `../extract.ts`. Throwing here is intentional — index.ts wraps every source
 * in try/catch, so a failed extraction marks the source unhealthy instead of
 * masquerading as a page with zero deals.
 */

import { extractDeals } from '../extract.js';
import type { Adapter } from './types.js';

export function createLlmPageAdapter(): Adapter {
  return {
    name: 'llm_page',
    async fetchDeals(ctx) {
      const { deals } = await extractDeals(ctx.body, ctx.vendor);
      return deals;
    },
  };
}
