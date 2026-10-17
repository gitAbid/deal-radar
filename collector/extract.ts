/**
 * LLM extraction: vendor page text → validated RawDeal[] + confidence.
 *
 * Speaks plain `fetch` to any OpenAI-compatible
 * `POST {LLM_BASE_URL}/chat/completions` with `response_format:
 * {type: 'json_object'}` — no SDK, so the provider is swappable by changing
 * `LLM_BASE_URL` / `LLM_MODEL` and nothing else (spec §16).
 *
 * Failure is deliberately loud:
 *   - a missing LLM_API_KEY throws immediately; returning [] would look
 *     identical to "no deals today", the exact silent failure the system
 *     exists to catch (spec §10);
 *   - an invalid or schema-violating model reply gets exactly one repair
 *     attempt (the error text is appended to the conversation), then throws.
 *
 * Confidence semantics: the extraction-level confidence is the *minimum*
 * across the returned deals — one shaky extraction must not be laundered by
 * confident neighbours. Every deal from this extraction carries that
 * aggregate, so index.ts's CONFIDENCE_FLOOR gate sees the pessimistic value.
 */

import { env } from './env.js';
import { isRecord, str, text } from './adapters/shared.js';
import type { RawDeal } from './types.js';

export interface ExtractionResult {
  deals: RawDeal[];
  confidence: number;
  repaired: boolean;
}

/** Characters of page text sent to the model. Bounds tokens (and cost) per call. */
export const TEXT_LIMIT = 12_000;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = [
  'You extract software deals from the text of a vendor page.',
  'Extract every concrete deal, discount, promo code or price reduction the page states.',
  'Ignore navigation, cookie banners, footers and unrelated marketing copy.',
  'For every deal set eligibility_note to any condition the vendor itself states,',
  'such as "new customers only", "annual plans only" or "region-locked".',
  'Reply with ONLY a JSON object of exactly this shape, no markdown fences, no commentary:',
  '{"deals":[{"title":string,"summary":string|null,"price_now":number|null,',
  '"price_was":number|null,"currency":string|null,"discount_pct":number|null,',
  '"promo_code":string|null,"starts_at":string|null,"ends_at":string|null,',
  '"url":string|null,"eligibility_note":string|null,"confidence":number}],',
  '"confidence":number}',
  'All confidence values are numbers between 0 and 1.',
  'If the page states no deals, reply {"deals":[],"confidence":<certainty that there are none>}.',
].join(' ');

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function extractDeals(
  body: string,
  vendor: { name: string; category: string },
): Promise<ExtractionResult> {
  const apiKey = env('LLM_API_KEY');
  if (apiKey === undefined) {
    throw new Error(
      'Missing LLM_API_KEY — refusing to extract. ' +
        'Returning no deals would be indistinguishable from there being no deals today (spec §10).',
    );
  }
  const baseUrl = (env('LLM_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env('LLM_MODEL') ?? DEFAULT_MODEL;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt(body, vendor) },
  ];

  const firstReply = await chatCompletion(baseUrl, apiKey, model, messages);

  try {
    return { ...parsePayload(firstReply), repaired: false };
  } catch (firstError) {
    // Spec §10: exactly one repair attempt, with the validation error appended.
    messages.push({ role: 'assistant', content: firstReply });
    messages.push({ role: 'user', content: repairPrompt(message(firstError)) });
  }

  const secondReply = await chatCompletion(baseUrl, apiKey, model, messages);
  try {
    return { ...parsePayload(secondReply), repaired: true };
  } catch (secondError) {
    throw new Error(`LLM extraction failed after one repair attempt: ${message(secondError)}`);
  }
}

function userPrompt(body: string, vendor: { name: string; category: string }): string {
  const pageText = truncateText(htmlToText(body), TEXT_LIMIT);
  return [
    `Vendor: ${vendor.name}`,
    `Category: ${vendor.category}`,
    '',
    '--- PAGE TEXT START ---',
    pageText,
    '--- PAGE TEXT END ---',
    '',
    'Extract the deals and reply with JSON only.',
  ].join('\n');
}

function repairPrompt(error: string): string {
  return (
    `Your previous reply was rejected: ${error}\n` +
    'Reply again with ONLY a valid JSON object matching the schema from the system prompt. ' +
    'No markdown fences, no commentary.'
  );
}

async function chatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await readText(res);
    throw new Error(`LLM endpoint returned HTTP ${res.status}${detail === '' ? '' : `: ${detail}`}`);
  }

  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch {
    throw new Error('LLM response envelope was not valid JSON');
  }
  const content = extractContent(envelope);
  if (content === null) throw new Error('LLM response contained no message content');
  return content;
}

/** Pulls `choices[0].message.content` out of an OpenAI-compatible envelope. */
function extractContent(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null;
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Some OpenAI-compatible servers return content as parts.
    const parts = content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : null))
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

interface ParsedExtraction {
  deals: RawDeal[];
  confidence: number;
}

/** Hand-rolled validation of the model's JSON — no schema library, no `any`. */
function parsePayload(content: string): ParsedExtraction {
  let root: unknown;
  try {
    root = JSON.parse(content);
  } catch (error) {
    throw new Error(`reply was not valid JSON (${message(error)})`);
  }
  if (!isRecord(root)) throw new Error('reply was not a JSON object');

  const rawDeals = root.deals;
  if (!Array.isArray(rawDeals)) throw new Error('"deals" must be an array');
  const topConfidence = confidenceValue(root.confidence, 'confidence');

  const parsed = rawDeals.map((entry, index) => parseDeal(entry, index, topConfidence));
  const aggregate =
    parsed.length === 0 ? topConfidence : Math.min(...parsed.map((deal) => deal.confidence));

  return {
    deals: parsed.map((deal) => ({ ...deal, confidence: aggregate })),
    confidence: aggregate,
  };
}

function parseDeal(
  entry: unknown,
  index: number,
  fallbackConfidence: number,
): RawDeal & { confidence: number } {
  const where = `deals[${index}]`;
  if (!isRecord(entry)) throw new Error(`${where} must be an object`);

  const title = str(entry.title, 300);
  if (title === null) throw new Error(`${where}.title must be a non-empty string`);

  const confidence =
    entry.confidence === null || entry.confidence === undefined
      ? fallbackConfidence
      : confidenceValue(entry.confidence, `${where}.confidence`);

  return {
    title,
    summary: text(entry.summary, 2_000),
    price_now: optionalNumber(entry.price_now),
    price_was: optionalNumber(entry.price_was),
    currency: str(entry.currency, 12),
    discount_pct: optionalNumber(entry.discount_pct),
    promo_code: str(entry.promo_code, 100),
    starts_at: optionalDateString(entry.starts_at),
    ends_at: optionalDateString(entry.ends_at),
    url: str(entry.url, 2_000),
    eligibility_note: str(entry.eligibility_note, 500),
    confidence,
  };
}

/** Confidence must be a real number in [0, 1]; anything else is a violation. */
function confidenceValue(value: unknown, where: string): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`${where} must be a number between 0 and 1`);
  if (n < 0 || n > 1) throw new Error(`${where} must be between 0 and 1 (got ${n})`);
  return n;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function optionalDateString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, 64);
}

/** HTML → plain text for the prompt. Keeps block structure, drops markup. */
export function htmlToText(html: string): string {
  const withoutMarkup = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|header|footer|nav)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');

  return decodeEntities(withoutMarkup)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(input: string): string {
  return input.replace(
    /&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi,
    (match: string, entity: string): string => {
      if (entity.startsWith('#')) {
        const hex = entity.startsWith('#x') || entity.startsWith('#X');
        const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[...truncated]`;
}

async function readText(res: Response): Promise<string> {
  try {
    const body = await res.text();
    return body.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
