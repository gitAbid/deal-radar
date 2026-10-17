import { Suspense } from 'react';
import { connection } from 'next/server';
import { EmptyState, HealthPill, Loading, Pill, tdClass, thClass } from '@/components/ui';
import { query } from '@/lib/db';
import { relativeDays, stamp } from '@/lib/format';
import type { Health, SourceWithVendor } from '@/lib/types';

export const metadata = { title: 'Sources' };

export default function SourcesPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold tracking-tight">Sources</h1>
      <p className="text-xs text-neutral-500">
        Collection health. Degraded and failing sources sort to the top — this is where silent
        breakage shows up first. A source that is enabled but overdue has not been checked by the
        scheduler.
      </p>
      <Suspense fallback={<Loading label="Loading sources" />}>
        <SourcesView />
      </Suspense>
    </div>
  );
}

async function loadSources(): Promise<SourceWithVendor[]> {
  const result = await query<SourceWithVendor>(
    `
      SELECT s.*,
             v.name AS vendor_name,
             v.slug AS vendor_slug,
             v.category,
             v.tier
      FROM source s
      JOIN vendor v ON v.id = s.vendor_id
      ORDER BY CASE s.health
                 WHEN 'failing'  THEN 0
                 WHEN 'degraded' THEN 1
                 WHEN 'ok'       THEN 2
                 ELSE 3
               END,
               s.consecutive_failures DESC,
               v.name ASC
    `,
  );
  return result.rows;
}

function isOverdue(source: SourceWithVendor, now: Date): boolean {
  if (!source.enabled || source.health === 'disabled') return false;
  if (source.last_checked_at === null) return true;
  return now.getTime() - source.last_checked_at.getTime() > source.cadence_minutes * 2 * 60_000;
}

async function SourcesView() {
  await connection();
  const now = new Date();
  const sources = await loadSources();

  const counts: Record<Health, number> = { failing: 0, degraded: 0, ok: 0, disabled: 0 };
  for (const source of sources) counts[source.health] += 1;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        <Pill tone="bad">{counts.failing} failing</Pill>
        <Pill tone="warn">{counts.degraded} degraded</Pill>
        <Pill tone="ok">{counts.ok} ok</Pill>
        <Pill tone="muted">{counts.disabled} disabled</Pill>
        <span className="text-[11px] text-neutral-400">{sources.length} sources total</span>
      </div>

      {sources.length === 0 ? (
        <EmptyState
          title="No sources yet."
          hint="The watchlist has not been seeded into this database. Run pnpm seed in the repository root, then reload this page."
        />
      ) : (
        <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className={thClass}>Vendor</th>
                <th className={thClass}>Kind</th>
                <th className={thClass}>Health</th>
                <th className={thClass}>Last checked</th>
                <th className={thClass}>Last changed</th>
                <th className={`${thClass} text-right`}>Fails</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const overdue = isOverdue(source, now);
                return (
                  <tr key={source.id} className="border-b border-neutral-100 last:border-b-0">
                    <td className={`${tdClass} min-w-[260px]`}>
                      <div className="font-medium text-neutral-800">
                        {source.vendor_name}
                        <span className="ml-1.5 text-[11px] font-normal text-neutral-400">
                          tier {source.tier}
                        </span>
                      </div>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={source.url}
                        className="block max-w-[420px] truncate text-[11px] text-sky-700 hover:underline"
                      >
                        {source.url}
                      </a>
                      {source.note ? (
                        <div className="mt-0.5 max-w-[420px] text-[11px] text-neutral-400">{source.note}</div>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <div>{source.kind}</div>
                      <div className="text-[11px] text-neutral-400">
                        {source.adapter} · every {source.cadence_minutes}m
                        {source.enabled ? '' : ' · disabled'}
                      </div>
                    </td>
                    <td className={tdClass}>
                      <HealthPill health={source.health} />
                    </td>
                    <td className={`${tdClass} whitespace-nowrap`} title={stamp(source.last_checked_at)}>
                      {source.last_checked_at ? (
                        relativeDays(source.last_checked_at, now)
                      ) : (
                        <span className="text-neutral-400">never</span>
                      )}
                      {overdue ? (
                        <span className="ml-1.5 font-medium text-amber-700">overdue</span>
                      ) : null}
                    </td>
                    <td className={`${tdClass} whitespace-nowrap`} title={stamp(source.last_changed_at)}>
                      {source.last_changed_at ? (
                        relativeDays(source.last_changed_at, now)
                      ) : (
                        <span className="text-neutral-300">—</span>
                      )}
                    </td>
                    <td
                      className={`${tdClass} text-right tabular-nums ${
                        source.consecutive_failures > 0 ? 'font-semibold text-red-700' : 'text-neutral-400'
                      }`}
                    >
                      {source.consecutive_failures}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
