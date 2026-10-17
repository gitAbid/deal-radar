/**
 * Telegram alerting.
 *
 * Contract: `notify` NEVER throws. Every failure — missing config, network
 * error, non-2xx, even Telegram's own `ok: false` — becomes
 * `{status: 'failed', error}`. index.ts records that in the alert table and
 * the deal is re-evaluated on the next run (spec §10): a lost alert is worse
 * than a failed one, and a silent drop would be the worst of all.
 *
 * Safety: interpolated values are HTML-escaped, because Telegram is called
 * with `parse_mode: 'HTML'`. A vendor title containing `<` must not break the
 * message or inject markup.
 *
 * In-process rate limit: at most 20 messages per rolling minute. Exceeding it
 * is a `failed` result, not a throw — and not a silent drop: the caller marks
 * the alert failed, so the retry and the reason are visible on /runs.
 */

import { env } from './env.js';
import { isRecord } from './adapters/shared.js';
import type { Deal } from './types.js';

export interface AlertResult {
  status: 'sent' | 'failed';
  error?: string;
}

const MAX_PER_MINUTE = 20;
const RATE_WINDOW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** PeraByte operates from Bangladesh (spec §1); show times in UTC+6. */
const OPERATOR_TIMEZONE = 'Asia/Dhaka';
const OPERATOR_TZ_LABEL = 'UTC+6';

/** Timestamps of sends that consumed a rate-limit slot. Module-level, in-process. */
const sentAt: number[] = [];

export async function notify(deal: Deal, vendorName: string): Promise<AlertResult> {
  try {
    const token = env('TELEGRAM_BOT_TOKEN');
    if (token === undefined) return { status: 'failed', error: 'TELEGRAM_BOT_TOKEN is not set' };
    const chatId = env('TELEGRAM_CHAT_ID');
    if (chatId === undefined) return { status: 'failed', error: 'TELEGRAM_CHAT_ID is not set' };

    if (!acquireRateSlot(Date.now())) {
      return {
        status: 'failed',
        error: `Telegram rate limit reached (max ${MAX_PER_MINUTE} messages/minute)`,
      };
    }

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildMessage(deal, vendorName),
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await readText(res);
      return {
        status: 'failed',
        error: `Telegram HTTP ${res.status}${detail === '' ? '' : `: ${detail}`}`,
      };
    }

    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (isRecord(payload) && payload.ok === true) return { status: 'sent' };

    const description =
      isRecord(payload) && typeof payload.description === 'string'
        ? payload.description
        : 'unparseable response';
    return { status: 'failed', error: `Telegram API error: ${description}` };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** The alert body. Every interpolated value is escaped; only our own tags are markup. */
function buildMessage(deal: Deal, vendorName: string): string {
  const lines: string[] = [`🔥 <b>${escapeHtml(vendorName)}</b>`, escapeHtml(deal.title)];

  const now = formatMoney(deal.price_now, deal.currency);
  const was = formatMoney(deal.price_was, deal.currency);
  const discount = formatDiscount(deal.discount_pct);
  if (now !== null || was !== null || discount !== null) {
    const parts: string[] = [];
    if (now !== null) parts.push(was === null ? `Price: ${now}` : `Price: ${now} (was ${was})`);
    else if (was !== null) parts.push(`Was: ${was}`);
    if (discount !== null) parts.push(discount);
    lines.push(parts.join(' · '));
  }

  if (deal.promo_code) lines.push(`Code: <code>${escapeHtml(deal.promo_code)}</code>`);

  const ends = formatEndsAt(deal.ends_at);
  if (ends !== null) lines.push(`Ends: ${ends}`);

  if (deal.eligibility_note) lines.push(`Eligibility: ${escapeHtml(deal.eligibility_note)}`);
  if (deal.url) lines.push(escapeHtml(deal.url));

  return lines.join('\n');
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMoney(amount: number | null | undefined, currency: string): string | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  const ccy = currency.trim() === '' ? 'USD' : currency.trim().toUpperCase();
  return `${ccy} ${amount.toFixed(2)}`;
}

function formatDiscount(pct: number | null | undefined): string | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct) || pct <= 0) return null;
  return `${Math.round(pct * 100) / 100}% off`;
}

/** `ends_at` in the operator's timezone; invalid dates are omitted, never thrown on. */
function formatEndsAt(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: OPERATOR_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} (${OPERATOR_TZ_LABEL})`;
}

function acquireRateSlot(now: number): boolean {
  while (sentAt.length > 0 && now - (sentAt[0] ?? now) >= RATE_WINDOW_MS) sentAt.shift();
  if (sentAt.length >= MAX_PER_MINUTE) return false;
  sentAt.push(now);
  return true;
}

async function readText(res: Response): Promise<string> {
  try {
    const body = await res.text();
    return body.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}
