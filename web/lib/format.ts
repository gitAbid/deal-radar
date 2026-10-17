import type { DealStatus, Health } from './types';

const currencyFormatters = new Map<string, Intl.NumberFormat>();

function currencyFormatter(currency: string): Intl.NumberFormat {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    currencyFormatters.set(currency, formatter);
  }
  return formatter;
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(2)));
}

export function money(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const code = (currency ?? 'USD').toUpperCase();
  try {
    return currencyFormatter(code).format(value);
  } catch {
    return `${code} ${trimNumber(value)}`;
  }
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${trimNumber(value)}%`;
}

export function scoreValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toFixed(1);
}

export function confidencePct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

/** Compact relative time: "in 3d", "5h ago", "in <1m". Null → "—". */
export function relativeDays(date: Date | null | undefined, now: Date = new Date()): string {
  if (!date) return '—';
  const diffMs = date.getTime() - now.getTime();
  const future = diffMs >= 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  if (minutes < 1) return future ? 'in <1m' : '<1m ago';
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return future ? `in ${days}d` : `${days}d ago`;
  const months = Math.round(days / 30);
  return future ? `in ${months}mo` : `${months}mo ago`;
}

/** Absolute UTC timestamp for tooltips: "2026-10-17 15:30 UTC". */
export function stamp(date: Date | null | undefined): string {
  if (!date) return 'never';
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Duration between two timestamps: "12.4s", "1m 04s", "—". */
export function duration(start: Date | null | undefined, end: Date | null | undefined): string {
  if (!start || !end) return '—';
  const seconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

export const ENDING_SOON_MS = 72 * 60 * 60 * 1000;

export function isEndingSoon(endsAt: Date | null | undefined, now: Date): boolean {
  if (!endsAt) return false;
  const diffMs = endsAt.getTime() - now.getTime();
  return diffMs >= 0 && diffMs <= ENDING_SOON_MS;
}

export function hasEnded(endsAt: Date | null | undefined, now: Date): boolean {
  return endsAt !== null && endsAt !== undefined && endsAt.getTime() < now.getTime();
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

const toneClasses: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warn: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  bad: 'bg-red-50 text-red-700 ring-red-600/20',
  muted: 'bg-neutral-100 text-neutral-600 ring-neutral-500/20',
  info: 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

export function badgeClass(tone: Tone): string {
  return `inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${toneClasses[tone]}`;
}

export function healthTone(health: Health): Tone {
  switch (health) {
    case 'ok':
      return 'ok';
    case 'degraded':
      return 'warn';
    case 'failing':
      return 'bad';
    case 'disabled':
      return 'muted';
  }
}

export function statusTone(status: DealStatus): Tone {
  switch (status) {
    case 'published':
      return 'ok';
    case 'needs_review':
      return 'warn';
    case 'rejected':
    case 'expired':
      return 'muted';
  }
}
