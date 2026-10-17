import { Suspense } from 'react';
import { connection } from 'next/server';
import { EmptyState, Loading, Pill } from '@/components/ui';
import { query } from '@/lib/db';
import { confidencePct, money, pct, relativeDays, stamp } from '@/lib/format';
import type { DealWithVendor } from '@/lib/types';
import { approveDeal, rejectDeal } from './actions';

export const metadata = { title: 'Review' };

export default function ReviewPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold tracking-tight">Review queue</h1>
      <p className="text-xs text-neutral-500">
        Extractions that fell below the confidence floor, waiting on a human. Approving publishes
        the deal; rejecting keeps it out. These two decisions are the only writes in the dashboard.
      </p>
      <Suspense fallback={<Loading label="Loading review queue" />}>
        <ReviewView />
      </Suspense>
    </div>
  );
}

async function loadReviewQueue(): Promise<DealWithVendor[]> {
  const result = await query<DealWithVendor>(
    `
      SELECT d.*,
             v.name     AS vendor_name,
             v.slug     AS vendor_slug,
             v.category,
             v.tier,
             count(*) OVER () AS total_count
      FROM deal d
      JOIN vendor v ON v.id = d.vendor_id
      WHERE d.status = 'needs_review'
      ORDER BY d.first_seen_at DESC
    `,
  );
  return result.rows;
}

async function ReviewView() {
  await connection();
  const now = new Date();
  const deals = await loadReviewQueue();

  if (deals.length === 0) {
    return (
      <EmptyState
        title="Nothing needs review."
        hint="Extractions below the confidence floor land here. An empty queue means the collector is either finding nothing or finding deals it trusts."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-neutral-500">{deals.length} waiting</p>
      {deals.map((deal) => (
        <div key={deal.id} className="rounded border border-neutral-200 bg-white p-3">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Pill tone="warn">needs review</Pill>
            <span className="text-xs font-medium text-neutral-600">{deal.vendor_name}</span>
            <span className="text-[11px] text-neutral-400">
              {deal.category} · tier {deal.tier}
            </span>
            <span className="text-[11px] text-neutral-400">
              confidence {confidencePct(deal.confidence)}
            </span>
            <span className="text-[11px] text-neutral-400" title={stamp(deal.first_seen_at)}>
              first seen {relativeDays(deal.first_seen_at, now)}
            </span>
          </div>

          <div className="mt-2">
            {deal.url ? (
              <a
                href={deal.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-medium text-sky-700 hover:underline"
              >
                {deal.title}
              </a>
            ) : (
              <span className="text-sm font-medium">{deal.title}</span>
            )}
          </div>

          {deal.summary ? (
            <p className="mt-1 max-w-4xl text-xs text-neutral-600">{deal.summary}</p>
          ) : null}
          {deal.eligibility_note ? (
            <p className="mt-1 text-xs text-amber-700">Eligibility: {deal.eligibility_note}</p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-600">
            <span>
              price {money(deal.price_now, deal.currency)}
              {deal.price_was !== null && deal.price_was !== undefined ? (
                <span className="text-neutral-400"> (was {money(deal.price_was, deal.currency)})</span>
              ) : null}
            </span>
            <span>discount {pct(deal.discount_pct)}</span>
            <span>
              code {deal.promo_code ? <code className="font-mono">{deal.promo_code}</code> : '—'}
            </span>
            <span title={stamp(deal.ends_at)}>
              ends {deal.ends_at ? relativeDays(deal.ends_at, now) : '—'}
            </span>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <form action={approveDeal}>
              <input type="hidden" name="deal_id" value={deal.id} />
              <button
                type="submit"
                className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Approve → published
              </button>
            </form>
            <form action={rejectDeal}>
              <input type="hidden" name="deal_id" value={deal.id} />
              <button
                type="submit"
                className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
              >
                Reject
              </button>
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}
