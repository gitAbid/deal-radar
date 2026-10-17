import type { ReactNode } from 'react';
import { badgeClass, healthTone, statusTone, type Tone } from '@/lib/format';
import type { DealStatus, Health } from '@/lib/types';

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-neutral-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-medium text-neutral-700">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-xl text-xs text-neutral-500">{hint}</p> : null}
    </div>
  );
}

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={badgeClass(tone)} title={title}>
      {children}
    </span>
  );
}

export function HealthPill({ health }: { health: Health }) {
  return <Pill tone={healthTone(health)}>{health}</Pill>;
}

export function StatusPill({ status }: { status: DealStatus }) {
  return <Pill tone={statusTone(status)}>{status.replace('_', ' ')}</Pill>;
}

export function Loading({ label }: { label: string }) {
  return <p className="px-1 py-6 text-xs text-neutral-500">{label}…</p>;
}

/** Shared table cell classes, kept here so every table stays dense and aligned. */
export const thClass =
  'sticky top-0 z-10 whitespace-nowrap border-b border-neutral-200 bg-white px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-neutral-500';
export const tdClass = 'px-3 py-2 align-top';
