import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { EmptyState, Loading, tdClass, thClass } from '@/components/ui';
import {
  countPublishedDeals,
  DEAL_PAGE_LIMIT,
  filtersToSearchParams,
  listDeals,
  parseDealFilters,
  type DealFilters,
  type DealSort,
} from '@/lib/deals';
import { hasEnded, isEndingSoon, money, pct, relativeDays, scoreValue, stamp } from '@/lib/format';
import { CATEGORIES, type DealWithVendor } from '@/lib/types';

export const metadata = { title: 'Deals' };

const SORT_LABELS: Record<DealSort, string> = {
  score: 'Score',
  discount: 'Discount',
  ending: 'Ending',
};

export default function DealsPage(props: PageProps<'/'>) {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold tracking-tight">Deals</h1>
      <p className="text-xs text-neutral-500">
        Published deals, best score first. Filters live in the URL — every view is linkable.
        Ending-soon rows are highlighted.
      </p>
      <Suspense fallback={<Loading label="Loading deals" />}>
        <DealsView searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function DealsView({ searchParams }: Pick<PageProps<'/'>, 'searchParams'>) {
  // Force this subtree to render per request (Cache Components), so the table
  // is never a build-time snapshot and `new Date()` is valid here.
  await connection();
  const filters = parseDealFilters(await searchParams);
  const now = new Date();
  const deals = await listDeals(filters);

  if (deals.length === 0) {
    const publishedTotal = await countPublishedDeals();
    return (
      <>
        <FilterBar filters={filters} shown={0} total={0} />
        {publishedTotal === 0 ? (
          <EmptyState
            title="No published deals yet."
            hint={
              <>
                The collector has not published anything. Check{' '}
                <Link className="underline" href="/sources">
                  Sources
                </Link>{' '}
                for collection health.
              </>
            }
          />
        ) : (
          <EmptyState
            title="No deals match these filters."
            hint={
              <Link className="underline" href="/">
                Clear filters
              </Link>
            }
          />
        )}
      </>
    );
  }

  const total = deals[0]?.total_count ?? deals.length;

  return (
    <>
      <FilterBar filters={filters} shown={deals.length} total={total} />
      <DealsTable deals={deals} now={now} />
    </>
  );
}

function FilterBar({ filters, shown, total }: { filters: DealFilters; shown: number; total: number }) {
  const sortLink = (sort: DealSort) => {
    const params = filtersToSearchParams({ ...filters, sort });
    const href = params.size > 0 ? `/?${params.toString()}` : '/';
    const active = filters.sort === sort;
    return (
      <Link
        key={sort}
        href={href}
        className={active ? 'font-medium text-neutral-900' : 'text-neutral-500 hover:text-neutral-900'}
      >
        {SORT_LABELS[sort]}
      </Link>
    );
  };

  const fieldClass =
    'rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none';
  const labelClass = 'flex flex-col gap-1 text-[11px] font-medium text-neutral-500';

  return (
    <div className="space-y-2 rounded border border-neutral-200 bg-white p-3">
      <form method="get" action="/" className="flex flex-wrap items-end gap-2">
        <label className={labelClass}>
          Search
          <input
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="title, summary, code"
            className={`${fieldClass} w-56`}
          />
        </label>
        <label className={labelClass}>
          Category
          <select name="category" defaultValue={filters.category ?? ''} className={fieldClass}>
            <option value="">All</option>
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Tier
          <select name="tier" defaultValue={filters.tier ? String(filters.tier) : ''} className={fieldClass}>
            <option value="">All</option>
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
        <label className={labelClass}>
          Min discount %
          <input
            name="min_discount"
            type="number"
            min={0}
            max={100}
            step={5}
            defaultValue={filters.minDiscount ?? ''}
            className={`${fieldClass} w-24`}
          />
        </label>
        <label className={labelClass}>
          Ending within (days)
          <input
            name="ending_days"
            type="number"
            min={1}
            max={365}
            defaultValue={filters.endingDays ?? ''}
            className={`${fieldClass} w-24`}
          />
        </label>
        <input type="hidden" name="sort" value={filters.sort} />
        <button
          type="submit"
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
        >
          Apply
        </button>
        <Link href="/" className="px-1 py-1.5 text-xs text-neutral-500 hover:text-neutral-900">
          Reset
        </Link>
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          <span className="text-[11px] uppercase tracking-wide text-neutral-400">Sort</span>
          {(['score', 'discount', 'ending'] as const).map(sortLink)}
        </div>
      </form>
      <p className="text-[11px] text-neutral-500">
        {shown === total
          ? `${total} deal${total === 1 ? '' : 's'}`
          : `${shown} of ${total} · showing first ${DEAL_PAGE_LIMIT}`}
      </p>
    </div>
  );
}

function DealsTable({ deals, now }: { deals: DealWithVendor[]; now: Date }) {
  return (
    <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={thClass}>Vendor</th>
            <th className={thClass}>Category</th>
            <th className={thClass}>Deal</th>
            <th className={`${thClass} text-right`}>Price</th>
            <th className={`${thClass} text-right`}>Disc %</th>
            <th className={thClass}>Code</th>
            <th className={thClass}>Ends</th>
            <th className={`${thClass} text-right`}>Score</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((deal) => {
            const ended = hasEnded(deal.ends_at, now);
            const soon = isEndingSoon(deal.ends_at, now);
            return (
              <tr
                key={deal.id}
                className={`border-b border-neutral-100 last:border-b-0 ${
                  soon ? 'bg-amber-50/70' : ended ? 'text-neutral-400' : ''
                }`}
              >
                <td className={tdClass}>
                  <div className="font-medium text-neutral-800">{deal.vendor_name}</div>
                  <div className="text-[11px] text-neutral-400">tier {deal.tier}</div>
                </td>
                <td className={tdClass}>{deal.category}</td>
                <td className={`${tdClass} min-w-[280px] max-w-[460px]`}>
                  {deal.url ? (
                    <a
                      href={deal.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium text-sky-700 hover:underline"
                    >
                      {deal.title}
                    </a>
                  ) : (
                    <span className="font-medium">{deal.title}</span>
                  )}
                  {deal.eligibility_note ? (
                    <div className="mt-0.5 text-[11px] text-amber-700">{deal.eligibility_note}</div>
                  ) : null}
                  {deal.summary ? (
                    <div className="mt-0.5 line-clamp-2 text-[11px] text-neutral-500">{deal.summary}</div>
                  ) : null}
                </td>
                <td className={`${tdClass} whitespace-nowrap text-right`}>
                  <div>{money(deal.price_now, deal.currency)}</div>
                  {deal.price_was !== null && deal.price_was !== undefined ? (
                    <div className="text-[11px] text-neutral-400 line-through">
                      {money(deal.price_was, deal.currency)}
                    </div>
                  ) : null}
                </td>
                <td className={`${tdClass} text-right font-medium`}>{pct(deal.discount_pct)}</td>
                <td className={tdClass}>
                  {deal.promo_code ? (
                    <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[11px]">
                      {deal.promo_code}
                    </code>
                  ) : (
                    <span className="text-neutral-300">—</span>
                  )}
                </td>
                <td className={`${tdClass} whitespace-nowrap`} title={stamp(deal.ends_at)}>
                  {deal.ends_at ? relativeDays(deal.ends_at, now) : <span className="text-neutral-300">—</span>}
                  {soon ? <span className="ml-1 text-[11px] font-medium text-amber-700">soon</span> : null}
                  {ended ? <span className="ml-1 text-[11px]">ended</span> : null}
                </td>
                <td className={`${tdClass} text-right font-semibold tabular-nums`}>
                  {scoreValue(deal.score)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
