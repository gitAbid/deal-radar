import Link from 'next/link';
import { Suspense } from 'react';
import { connection } from 'next/server';
import { EmptyState, Loading, Pill, tdClass, thClass } from '@/components/ui';
import { query } from '@/lib/db';
import { money } from '@/lib/format';
import type { TargetWithVendor } from '@/lib/types';
import { createTarget, deleteTarget, toggleTargetActive, updateTarget } from './actions';
import { DeleteTargetButton } from './delete-target-button';
import { TargetForm } from './target-form';
import type { VendorOption } from './types';

export const metadata = { title: 'Targets' };

export default function TargetsPage(props: PageProps<'/targets'>) {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold tracking-tight">Targets</h1>
      <p className="text-xs text-neutral-500">
        What PeraByte intends to buy. An active target matching on vendor or keyword is what makes
        a deal eligible for a Telegram alert — with no active targets, alerting cannot fire.
      </p>
      <Suspense fallback={<Loading label="Loading targets" />}>
        <TargetsView searchParams={props.searchParams} />
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

async function loadVendors(): Promise<VendorOption[]> {
  const result = await query<VendorOption>(
    `SELECT id, name, category, tier FROM vendor ORDER BY name ASC`,
  );
  return result.rows;
}

async function TargetsView({ searchParams }: Pick<PageProps<'/targets'>, 'searchParams'>) {
  await connection();
  const params = await searchParams;
  const [targets, vendors] = await Promise.all([loadTargets(), loadVendors()]);

  // Edit is URL state (`?edit=<id>`): the same form creates and edits, and a
  // plain link is all it takes to open one row for editing.
  const rawEdit = Array.isArray(params.edit) ? params.edit[0] : params.edit;
  const editId = rawEdit !== undefined && /^\d+$/.test(rawEdit) ? Number(rawEdit) : null;
  const editing = editId === null ? null : (targets.find((target) => target.id === editId) ?? null);

  return (
    <>
      <TargetForm
        key={editing?.id ?? 'new'}
        action={editing ? updateTarget : createTarget}
        vendors={vendors}
        target={editing}
      />
      {editId !== null && editing === null ? (
        <p className="text-xs text-amber-700">
          Target #{editId} no longer exists — showing the form for a new target instead.
        </p>
      ) : null}
      {targets.length === 0 ? (
        <EmptyState
          title="No targets yet."
          hint="Create one above. Until an active target matches, every deal scores with relevance 0 and no Telegram alerts can be sent."
        />
      ) : (
        <>
          <p className="px-1 text-[11px] text-neutral-500">
            {targets.length} target{targets.length === 1 ? '' : 's'} ·{' '}
            {targets.filter((target) => target.active).length} active
          </p>
          <TargetsTable targets={targets} />
        </>
      )}
    </>
  );
}

function TargetsTable({ targets }: { targets: TargetWithVendor[] }) {
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
            <th className={thClass}>Actions</th>
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
              <td className={tdClass}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/targets?edit=${target.id}`} className="text-sky-700 hover:underline">
                    Edit
                  </Link>
                  <form action={toggleTargetActive}>
                    <input type="hidden" name="target_id" value={target.id} />
                    <button type="submit" className="text-neutral-700 hover:underline">
                      {target.active ? 'Pause' : 'Activate'}
                    </button>
                  </form>
                  <form action={deleteTarget}>
                    <input type="hidden" name="target_id" value={target.id} />
                    <DeleteTargetButton />
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
