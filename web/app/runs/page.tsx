import { Suspense } from 'react';
import { connection } from 'next/server';
import { EmptyState, Loading, Pill, tdClass, thClass } from '@/components/ui';
import { query } from '@/lib/db';
import { duration, relativeDays, stamp } from '@/lib/format';
import type { RunLogRow } from '@/lib/types';

export const metadata = { title: 'Runs' };

export default function RunsPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold tracking-tight">Runs</h1>
      <p className="text-xs text-neutral-500">
        The most recent collector runs. Errors are expanded from the run_log JSONB — a silently
        broken run is readable here.
      </p>
      <Suspense fallback={<Loading label="Loading runs" />}>
        <RunsView />
      </Suspense>
    </div>
  );
}

async function loadRuns(): Promise<RunLogRow[]> {
  const result = await query<RunLogRow>(
    `SELECT * FROM run_log ORDER BY started_at DESC LIMIT 50`,
  );
  return result.rows;
}

/** Turn run_log.errors (JSONB) into readable lines — never "[object Object]". */
function describeErrors(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item !== null && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const where: string[] = [];
      if (record.sourceId !== undefined && record.sourceId !== null) {
        where.push(`source ${String(record.sourceId)}`);
      }
      if (typeof record.url === 'string' && record.url) where.push(record.url);
      const message =
        typeof record.message === 'string' ? record.message : JSON.stringify(record);
      return where.length > 0 ? `${where.join(' · ')} — ${message}` : message;
    }
    return String(item);
  });
}

async function RunsView() {
  await connection();
  const now = new Date();
  const runs = await loadRuns();

  if (runs.length === 0) {
    return (
      <EmptyState
        title="No runs recorded yet."
        hint="The collector writes one run_log row per run. If this stays empty after the first scheduled collect, the scheduler itself is not firing."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded border border-neutral-200 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={thClass}>Started</th>
            <th className={thClass}>Duration</th>
            <th className={`${thClass} text-right`}>Sources</th>
            <th className={`${thClass} text-right`}>Failed</th>
            <th className={`${thClass} text-right`}>Pages</th>
            <th className={`${thClass} text-right`}>LLM ok</th>
            <th className={`${thClass} text-right`}>LLM low</th>
            <th className={`${thClass} text-right`}>New deals</th>
            <th className={thClass}>Errors</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const errors = describeErrors(run.errors);
            const troubled = run.sources_failed > 0 || errors.length > 0;
            return (
              <tr
                key={run.id}
                className={`border-b border-neutral-100 last:border-b-0 ${
                  troubled ? 'bg-red-50/50' : ''
                }`}
              >
                <td className={`${tdClass} whitespace-nowrap`} title={stamp(run.started_at)}>
                  {relativeDays(run.started_at, now)}
                  {run.finished_at === null ? (
                    <span className="ml-1.5">
                      <Pill tone="warn">unfinished</Pill>
                    </span>
                  ) : null}
                </td>
                <td className={`${tdClass} whitespace-nowrap tabular-nums`}>
                  {duration(run.started_at, run.finished_at)}
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{run.sources_checked}</td>
                <td
                  className={`${tdClass} text-right tabular-nums ${
                    run.sources_failed > 0 ? 'font-semibold text-red-700' : 'text-neutral-400'
                  }`}
                >
                  {run.sources_failed}
                </td>
                <td className={`${tdClass} text-right tabular-nums`}>{run.pages_fetched}</td>
                <td className={`${tdClass} text-right tabular-nums`}>{run.extractions_ok}</td>
                <td
                  className={`${tdClass} text-right tabular-nums ${
                    run.extractions_low_confidence > 0 ? 'font-medium text-amber-700' : 'text-neutral-400'
                  }`}
                >
                  {run.extractions_low_confidence}
                </td>
                <td
                  className={`${tdClass} text-right tabular-nums ${
                    run.new_deals > 0 ? 'font-semibold text-emerald-700' : 'text-neutral-400'
                  }`}
                >
                  {run.new_deals}
                </td>
                <td className={tdClass}>
                  {errors.length === 0 ? (
                    <span className="text-neutral-300">—</span>
                  ) : (
                    <details>
                      <summary className="cursor-pointer font-medium text-red-700">
                        {errors.length} error{errors.length === 1 ? '' : 's'}
                      </summary>
                      <ul className="mt-1 space-y-0.5">
                        {errors.map((line, index) => (
                          <li
                            key={index}
                            className="max-w-[560px] break-words font-mono text-[11px] text-red-800"
                          >
                            {line}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
