import { Suspense } from 'react';
import { connection } from 'next/server';
import { EmptyState, Loading, Pill, tdClass, thClass } from '@/components/ui';
import { query } from '@/lib/db';
import { money } from '@/lib/format';
import type { TargetWithVendor } from '@/lib/types';

export const metadata = { title: 'Targets' };

export default function TargetsPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold tracking-tight">Targets</h1>
      <p className="text-xs text-neutral-500">
        What PeraByte intends to buy. Targets drive the relevance term in scoring and decide which
        deals raise a Telegram alert. An active target matching on vendor or keyword ranks deals
        highest.
      </p>
      <Suspense fallback={<Loading label="Loading targets" />}>
        <TargetsView />
      </Suspense>
    </div>
  );
}

async function loadTargets(): Promise<TargetWithVendor[]> {
  const result = await query<TargetWithVendor>(
    `
      SELECT t.*,
             v.name AS vendor_name
      FROM target t
      LEFT JOIN vendor v ON v.id = t.vendor_id
      ORDER BY t.active DESC, t.priority ASC, t.id ASC
    `,
  );
  return result.rows;
}

async function TargetsView() {
  await connection();
  const targets = await loadTargets();

  if (targets.length === 0) {
    return (
      <EmptyState
        title="No targets yet."
        hint="With no targets, every deal scores with relevance 0 and no alerts can match. Targets are managed directly in Postgres for now — editing is not wired into this build of the dashboard."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={thClass}>Status</th>
            <th className={thClass}>Vendor</th>
            <th className={thClass}>Keyword</th>
            <th className={`${thClass} text-right`}>Max price</th>
            <th className={`${thClass} text-right`}>Priority</th>
          </tr>
        </thead>
        <tbody>
          {targets.map((target) => (
            <tr key={target.id} className="border-b border-neutral-100 last:border-b-0">
              <td className={tdClass}>
                {target.active ? <Pill tone="ok">active</Pill> : <Pill tone="muted">paused</Pill>}
              </td>
              <td className={tdClass}>
                {target.vendor_name ?? <span className="text-neutral-300">—</span>}
              </td>
              <td className={tdClass}>
                {target.keyword ? (
                  <code className="font-mono text-[11px]">{target.keyword}</code>
                ) : (
                  <span className="text-neutral-300">—</span>
                )}
              </td>
              <td className={`${tdClass} text-right tabular-nums`}>
                {money(target.max_price, 'USD')}
              </td>
              <td className={`${tdClass} text-right tabular-nums`}>{target.priority}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
