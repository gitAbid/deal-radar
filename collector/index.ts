/**
 * Orchestration: loadDueSources → fetch → extract → normalise → dedupe →
 * score → store → alert, with run logging and a heartbeat at the end.
 *
 * Implements spec §8 literally, with two deliberate reconciliations noted
 * inline (alert retry per §10, and run_log counters).
 *
 * Per-source isolation is absolute: every source is wrapped in its own
 * try/catch, so one vendor throwing can never abort the run or affect another.
 */

import { env, envNumber, isMainModule, loadEnv, requireEnv } from './env.js';
import { createFetcher, type Fetcher } from './fetcher.js';
import { createStore, createPool, type Store } from './store.js';
import { normalise } from './normalise.js';
import { classify } from './dedupe.js';
import { matchesTarget, score } from './score.js';
import { createRssAdapter } from './adapters/rss.js';
import { createHackerNewsAdapter } from './adapters/hackernews.js';
import { createRedditAdapter } from './adapters/reddit.js';
import { createLlmPageAdapter } from './adapters/llm-page.js';
import { extractDeals } from './extract.js';
import { notify } from './alert.js';
import { ping } from './heartbeat.js';
import type { Adapter, AdapterName, Deal, RunSummary, Target, Vendor } from './types.js';

const DEFAULT_USER_AGENT = 'DealRadar/1.0 (+https://github.com/gitAbid/deal-radar)';

/**
 * The composition seam. Tests replace any subset; production uses the
 * defaults. `extract` is the Workstream B entry point: its production caller
 * is `adapters/llm-page.ts`, and it is injected here so the whole pipeline has
 * one dependency surface.
 */
export interface CollectorDeps {
  store: Store;
  fetcher: Fetcher;
  adapters: Partial<Record<AdapterName, Adapter>>;
  notify: (deal: Deal, vendorName: string) => Promise<{ status: 'sent' | 'failed'; error?: string }>;
  ping: () => Promise<void>;
  extract: typeof extractDeals;
  now: () => Date;
}

export interface RunOnceOptions {
  dryRun?: boolean;
  /** Test seam: any subset of the real pipeline may be replaced. */
  deps?: Partial<CollectorDeps>;
}

export async function runOnce(options: RunOnceOptions = {}): Promise<RunSummary> {
  loadEnv();
  const dryRun = options.dryRun ?? false;
  const ownsPool = options.deps?.store === undefined;
  const pool = ownsPool ? createPool(requireEnv('DATABASE_URL')) : null;

  try {
    const deps: CollectorDeps = {
      store: options.deps?.store ?? createStore(pool!),
      fetcher:
        options.deps?.fetcher ??
        createFetcher({ userAgent: env('HTTP_USER_AGENT') ?? DEFAULT_USER_AGENT }),
      adapters: options.deps?.adapters ?? {},
      notify: options.deps?.notify ?? notify,
      ping: options.deps?.ping ?? ping,
      extract: options.deps?.extract ?? extractDeals,
      now: options.deps?.now ?? (() => new Date()),
    };
    return await executeRun(deps, dryRun);
  } finally {
    if (pool) await pool.end();
  }
}

async function executeRun(deps: CollectorDeps, dryRun: boolean): Promise<RunSummary> {
  const confidenceFloor = envNumber('CONFIDENCE_FLOOR', 0.6);
  const alertThreshold = envNumber('ALERT_THRESHOLD', 8);

  const summary: RunSummary = {
    runId: 0,
    sourcesChecked: 0,
    sourcesFailed: 0,
    pagesFetched: 0,
    extractionsOk: 0,
    extractionsLowConfidence: 0,
    newDeals: 0,
    errors: [],
  };

  const dueSources = await deps.store.listDueSources(deps.now());
  const targets = await deps.store.listActiveTargets();

  if (!dryRun) summary.runId = await deps.store.recordRunStart();

  const constructed = new Map<AdapterName, Adapter>();

  for (const source of dueSources) {
    const sourceId = source.id;
    try {
      if (sourceId === undefined) throw new Error('due source row has no id');
      const adapter = resolveAdapter(source.adapter, deps, constructed);

      const res = await deps.fetcher.fetch(source.url, {
        cache: { hash: source.content_hash },
        kind: source.kind,
      });
      summary.pagesFetched += 1;

      // Change detection gates the LLM: an unchanged page costs one HEAD-ish
      // request and nothing else. This is the biggest cost control in the run.
      if (source.kind === 'page' && !res.changed) {
        if (!dryRun) {
          await deps.store.markSourceChecked(sourceId, {
            hash: res.hash === '' ? undefined : res.hash,
            changed: false,
            ok: true,
            dealsFound: 0,
          });
        }
        summary.sourcesChecked += 1;
        continue;
      }

      const raws = await adapter.fetchDeals({
        vendor: source.vendor,
        source,
        body: res.body,
        fetcher: deps.fetcher,
        dryRun,
      });

      let dealsFound = 0;
      for (const raw of raws) {
        const deal = normalise(raw, {
          vendorId: source.vendor_id,
          sourceId,
          confidenceFloor,
        });
        const lowConfidence = deal.confidence < confidenceFloor;
        if (source.adapter === 'llm_page') {
          // Counter semantics: one llm_page extraction that produced at least
          // one usable deal counts as ok; an extraction whose deals all fall
          // below the floor counts as low confidence (/runs reads these).
          if (lowConfidence) summary.extractionsLowConfidence += 1;
          else summary.extractionsOk += 1;
        }
        dealsFound += 1;

        if (lowConfidence) {
          await storeLowConfidenceDeal(deal, deps, dryRun);
          continue;
        }

        const kind = await storeDeal(deal, source.vendor, targets, alertThreshold, deps, dryRun);
        if (kind === 'NEW') summary.newDeals += 1;
      }

      if (!dryRun) {
        await deps.store.markSourceChecked(sourceId, {
          hash: res.hash,
          changed: res.changed,
          ok: true,
          dealsFound,
        });
      }
      summary.sourcesChecked += 1;
    } catch (error) {
      // §8: never abort the run; one vendor's failure is its own.
      summary.sourcesFailed += 1;
      const message = errorMessage(error);
      summary.errors.push({ sourceId, url: source.url, message });
      if (!dryRun && sourceId !== undefined) {
        try {
          await deps.store.markSourceChecked(sourceId, {
            changed: false,
            ok: false,
            error: message,
            dealsFound: 0,
          });
        } catch (inner) {
          summary.errors.push({
            sourceId,
            url: source.url,
            message: `markSourceChecked failed: ${errorMessage(inner)}`,
          });
        }
      }
    }
  }

  if (!dryRun) {
    await deps.store.recordRunFinish(summary.runId, summary);
    try {
      await deps.ping();
    } catch (error) {
      // A dead-man's switch that fails must not fail the run it watched.
      summary.errors.push({ message: `heartbeat ping failed: ${errorMessage(error)}` });
    }
  }

  return summary;
}

function resolveAdapter(
  name: AdapterName,
  deps: CollectorDeps,
  cache: Map<AdapterName, Adapter>,
): Adapter {
  const injected = deps.adapters[name];
  if (injected !== undefined) return injected;
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const created = createAdapter(name);
  cache.set(name, created);
  return created;
}

function createAdapter(name: AdapterName): Adapter {
  switch (name) {
    case 'rss':
      return createRssAdapter();
    case 'hackernews':
      return createHackerNewsAdapter();
    case 'reddit':
      return createRedditAdapter();
    case 'llm_page':
      return createLlmPageAdapter();
  }
}

async function storeDeal(
  deal: Deal,
  vendor: Vendor,
  targets: Target[],
  alertThreshold: number,
  deps: CollectorDeps,
  dryRun: boolean,
): Promise<'NEW' | 'UPDATED' | 'DUPLICATE'> {
  const classification = await classify(deal, deps.store);

  if (classification.kind === 'NEW') {
    const scored = withScore(deal, targets, vendor, deps.now(), 'published');
    if (dryRun) return 'NEW';
    const stored = await deps.store.insertDeal(scored);
    await maybeAlert(stored, vendor, targets, alertThreshold, deps);
    return 'NEW';
  }

  const existingId = classification.existingId;
  if (existingId === undefined) return classification.kind;

  if (dryRun) return classification.kind;

  if (classification.kind === 'UPDATED') {
    const scored = withScore(deal, targets, vendor, deps.now(), deal.status);
    await deps.store.updateDealSeen(existingId, {
      title: scored.title,
      summary: scored.summary,
      price_now: scored.price_now,
      price_was: scored.price_was,
      currency: scored.currency,
      discount_pct: scored.discount_pct,
      promo_code: scored.promo_code,
      starts_at: scored.starts_at,
      ends_at: scored.ends_at,
      url: scored.url,
      eligibility_note: scored.eligibility_note,
      confidence: scored.confidence,
      score: scored.score,
      score_breakdown: scored.score_breakdown,
    });
  } else {
    // DUPLICATE: no new row, no re-score — just keep last_seen_at fresh.
    await deps.store.updateDealSeen(existingId, {});
  }

  // §10: a failed Telegram send is retried on the next run. A duplicate is
  // exactly how the next run sees that deal, so alerting is re-evaluated
  // against the stored row (never for needs_review, and never twice).
  const existing = await deps.store.findDealById(existingId);
  if (existing) await maybeAlert(existing, vendor, targets, alertThreshold, deps);
  return classification.kind;
}

async function storeLowConfidenceDeal(deal: Deal, deps: CollectorDeps, dryRun: boolean): Promise<void> {
  const classification = await classify(deal, deps.store);
  if (dryRun) return;

  if (classification.kind === 'NEW') {
    await deps.store.insertDeal({ ...deal, status: 'needs_review' });
    return;
  }
  if (classification.existingId === undefined) return;
  // Low-confidence data never overwrites the fields of an existing row; it
  // only proves the deal was seen again.
  await deps.store.updateDealSeen(classification.existingId, {});
}

function withScore(
  deal: Deal,
  targets: Target[],
  vendor: Vendor,
  now: Date,
  status: Deal['status'],
): Deal {
  const { score: total, breakdown } = score(deal, targets, undefined, { now, vendor });
  return { ...deal, status, score: total, score_breakdown: breakdown };
}

async function maybeAlert(
  deal: Deal,
  vendor: Vendor,
  targets: Target[],
  alertThreshold: number,
  deps: CollectorDeps,
): Promise<void> {
  if (deal.id === undefined) return;
  if (deal.status !== 'published') return;
  if ((deal.score ?? 0) < alertThreshold) return;
  if (!matchesTarget(deal, targets)) return;
  if ((await deps.store.alertsSentFor(deal.id)) > 0) return;

  try {
    const result = await deps.notify(deal, vendor.name);
    await deps.store.recordAlert(deal.id, result.status, result.error);
  } catch (error) {
    // notify() promises never to throw; if it does, the deal is still not
    // lost — it stays unpublished-alerted and is retried next run.
    await deps.store.recordAlert(deal.id, 'failed', errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatSummary(summary: RunSummary, dryRun: boolean): string {
  const lines = [
    `${dryRun ? 'DRY RUN (nothing written)' : 'collect run complete'} — run #${summary.runId}`,
    `  sources checked:          ${summary.sourcesChecked}`,
    `  sources failed:           ${summary.sourcesFailed}`,
    `  pages fetched:            ${summary.pagesFetched}`,
    `  extractions ok:           ${summary.extractionsOk}`,
    `  extractions low-conf:     ${summary.extractionsLowConfidence}`,
    `  new deals:                ${summary.newDeals}`,
  ];
  if (summary.errors.length > 0) {
    lines.push('  errors:');
    for (const error of summary.errors) {
      lines.push(`    - ${error.url ?? `source ${error.sourceId ?? '?'}`}: ${error.message}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const summary = await runOnce({ dryRun });
  console.log(formatSummary(summary, dryRun));
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('collect failed:', errorMessage(error));
    process.exitCode = 1;
  });
}
