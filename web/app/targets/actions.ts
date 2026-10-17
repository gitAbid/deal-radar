'use server';

import { refresh, revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import type { TargetFormState } from './types';

/**
 * Create/edit/activate/delete for `target` rows. Targets are what make the
 * alert path live: collector/index.ts only sends a Telegram alert when a deal
 * matches an ACTIVE target, so a dashboard that cannot create targets leaves
 * alerting permanently inert.
 *
 * Same shape as app/review/actions.ts: exported async functions taking
 * FormData, with `revalidatePath` after every mutation. create/update
 * additionally return a `TargetFormState` so a validation failure (e.g. a row
 * with neither vendor nor keyword, which the schema CHECK rejects) surfaces as
 * a readable inline error instead of an opaque database error.
 */

const MAX_KEYWORD_LENGTH = 100;
const MAX_PRICE_LIMIT = 1_000_000_000; // comfortably inside NUMERIC(12,2)

function entry(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Malformed ids are programmer errors, not user input — same guard as review's `decide`. */
function readTargetId(formData: FormData): number {
  const raw = formData.get('target_id');
  const targetId = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new Error(`Invalid target id: ${String(raw)}`);
  }
  return targetId;
}

interface TargetInput {
  vendorId: number | null;
  keyword: string | null;
  maxPrice: number | null;
  priority: number;
  active: boolean;
}

function parseInput(formData: FormData): { input: TargetInput } | { error: string } {
  const vendorRaw = entry(formData, 'vendor_id');
  const keyword = entry(formData, 'keyword');
  const maxPriceRaw = entry(formData, 'max_price');
  const priorityRaw = entry(formData, 'priority');
  const active = formData.get('active') !== null;

  let vendorId: number | null = null;
  if (vendorRaw !== '') {
    vendorId = Number(vendorRaw);
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
      return { error: 'Choose a vendor from the dropdown.' };
    }
  }

  // The schema CHECK (vendor_id IS NOT NULL OR keyword IS NOT NULL) is the
  // backstop; this is the readable version of the same rule.
  if (vendorId === null && keyword === '') {
    return { error: 'Give the target a vendor, a keyword, or both — a target with neither cannot match anything.' };
  }
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return { error: `Keyword must be ${MAX_KEYWORD_LENGTH} characters or fewer.` };
  }

  let maxPrice: number | null = null;
  if (maxPriceRaw !== '') {
    maxPrice = Number(maxPriceRaw);
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
      return { error: 'Max price must be a positive number, or left empty for no limit.' };
    }
    if (maxPrice > MAX_PRICE_LIMIT) {
      return { error: 'Max price is too large — use a value up to 1,000,000,000.' };
    }
    maxPrice = Math.round(maxPrice * 100) / 100; // NUMERIC(12,2)
  }

  let priority = 3;
  if (priorityRaw !== '') {
    priority = Number(priorityRaw);
    if (!Number.isInteger(priority) || priority < 1 || priority > 99) {
      return { error: 'Priority must be a whole number from 1 (highest) to 99.' };
    }
  }

  return {
    input: {
      vendorId,
      keyword: keyword === '' ? null : keyword,
      maxPrice,
      priority,
      active,
    },
  };
}

async function vendorExists(id: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM vendor WHERE id = $1', [id]);
  return result.rows.length > 0;
}

type CheckedInput = { input: TargetInput } | { error: string };

async function validatedInput(formData: FormData): Promise<CheckedInput> {
  const parsed = parseInput(formData);
  if ('error' in parsed) return { error: parsed.error };
  if (parsed.input.vendorId !== null && !(await vendorExists(parsed.input.vendorId))) {
    return {
      error: `Vendor #${parsed.input.vendorId} does not exist — refresh the page and pick one from the list.`,
    };
  }
  return { input: parsed.input };
}

export async function createTarget(
  _previous: TargetFormState,
  formData: FormData,
): Promise<TargetFormState> {
  const checked = await validatedInput(formData);
  if ('error' in checked) return { error: checked.error };
  const { vendorId, keyword, maxPrice, priority, active } = checked.input;

  await query(
    `INSERT INTO target (vendor_id, keyword, max_price, priority, active)
     VALUES ($1, $2, $3, $4, $5)`,
    [vendorId, keyword, maxPrice, priority, active],
  );

  revalidatePath('/targets');
  redirect('/targets');
}

export async function updateTarget(
  _previous: TargetFormState,
  formData: FormData,
): Promise<TargetFormState> {
  const targetId = readTargetId(formData);
  const checked = await validatedInput(formData);
  if ('error' in checked) return { error: checked.error };
  const { vendorId, keyword, maxPrice, priority, active } = checked.input;

  const result = await query(
    `UPDATE target
        SET vendor_id = $1, keyword = $2, max_price = $3, priority = $4, active = $5
      WHERE id = $6`,
    [vendorId, keyword, maxPrice, priority, active, targetId],
  );
  if (result.rowCount === 0) {
    return { error: `Target #${targetId} no longer exists — it may have been deleted.` };
  }

  revalidatePath('/targets');
  redirect('/targets');
}

/** Soft switch: keeps the row but takes it out of matching. */
export async function toggleTargetActive(formData: FormData): Promise<void> {
  const targetId = readTargetId(formData);
  await query(`UPDATE target SET active = NOT active WHERE id = $1`, [targetId]);
  revalidatePath('/targets');
  refresh();
}

/**
 * Deletes the target row and nothing else. `target.vendor_id` references
 * `vendor`, but no table references `target`, so no FK cascade can reach
 * `deal` (or `vendor`) from here.
 */
export async function deleteTarget(formData: FormData): Promise<void> {
  const targetId = readTargetId(formData);
  await query(`DELETE FROM target WHERE id = $1`, [targetId]);
  revalidatePath('/targets');
  refresh();
}
