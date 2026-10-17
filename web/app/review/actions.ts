'use server';

import { refresh, revalidatePath } from 'next/cache';
import { query } from '@/lib/db';

/**
 * The only writes in the dashboard: a human decision on a needs_review deal.
 * Guarded on the current status so a double-submit (or a stale page) cannot
 * re-decide a deal that has already been reviewed.
 */
async function decide(
  formData: FormData,
  status: 'published' | 'rejected',
): Promise<void> {
  const raw = formData.get('deal_id');
  const dealId = typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(dealId) || dealId <= 0) {
    throw new Error(`Invalid deal id: ${String(raw)}`);
  }

  await query(`UPDATE deal SET status = $1 WHERE id = $2 AND status = 'needs_review'`, [
    status,
    dealId,
  ]);

  revalidatePath('/review');
  revalidatePath('/');
  refresh();
}

export async function approveDeal(formData: FormData): Promise<void> {
  await decide(formData, 'published');
}

export async function rejectDeal(formData: FormData): Promise<void> {
  await decide(formData, 'rejected');
}
