'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import { EMPTY_TARGET_FORM_STATE, type TargetFormProps, type TargetFormValues } from './types';

/**
 * Create/edit form for a target. Client component because `useActionState`
 * surfaces the Server Action's validation errors inline and the fields are
 * controlled, so whatever was typed survives a rejected submission. Without
 * JavaScript the form still submits as a plain POST; only the inline error
 * cannot hydrate. The page keys this component so switching between "new" and
 * an Edit link remounts it with the right defaults.
 */
export function TargetForm({ action, vendors, target }: TargetFormProps) {
  const [state, formAction, pending] = useActionState(action, EMPTY_TARGET_FORM_STATE);
  const [values, setValues] = useState<TargetFormValues>(() => ({
    vendor_id: target?.vendor_id !== null && target?.vendor_id !== undefined ? String(target.vendor_id) : '',
    keyword: target?.keyword ?? '',
    max_price: target?.max_price !== null && target?.max_price !== undefined ? String(target.max_price) : '',
    priority: String(target?.priority ?? 3),
    active: target?.active ?? true,
  }));

  const vendorRef = useRef<HTMLSelectElement>(null);
  const activeRef = useRef<HTMLInputElement>(null);

  // React resets the form once a Server Action returns. Text and number inputs
  // are re-asserted from React state on the next render, but <select> and
  // checkboxes are not, so a rejected submission would silently drop the
  // chosen vendor / Active state. Re-assert them explicitly.
  useEffect(() => {
    if (vendorRef.current && vendorRef.current.value !== values.vendor_id) {
      vendorRef.current.value = values.vendor_id;
    }
    if (activeRef.current && activeRef.current.checked !== values.active) {
      activeRef.current.checked = values.active;
    }
  }, [state, values.vendor_id, values.active]);

  const editing = target !== null;
  const update = (patch: Partial<TargetFormValues>) =>
    setValues((previous) => ({ ...previous, ...patch }));

  const fieldClass =
    'rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none';
  const labelClass = 'flex flex-col gap-1 text-[11px] font-medium text-neutral-500';

  return (
    <form action={formAction} className="space-y-2 rounded border border-neutral-200 bg-white p-3">
      {editing ? <input type="hidden" name="target_id" value={target.id} /> : null}
      <div className="flex flex-wrap items-end gap-2">
        <label className={labelClass}>
          Vendor
          <select
            ref={vendorRef}
            name="vendor_id"
            value={values.vendor_id}
            onChange={(event) => update({ vendor_id: event.target.value })}
            className={`${fieldClass} w-64`}
          >
            <option value="">— any vendor (use keyword) —</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.name} · {vendor.category} · tier {vendor.tier}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Keyword
          <input
            name="keyword"
            value={values.keyword}
            onChange={(event) => update({ keyword: event.target.value })}
            placeholder="e.g. black friday"
            maxLength={100}
            className={`${fieldClass} w-52`}
          />
        </label>
        <label className={labelClass}>
          Max price (USD)
          <input
            name="max_price"
            type="number"
            min={0.01}
            step={0.01}
            value={values.max_price}
            onChange={(event) => update({ max_price: event.target.value })}
            placeholder="no limit"
            className={`${fieldClass} w-28`}
          />
        </label>
        <label className={labelClass}>
          Priority (1 = highest)
          <input
            name="priority"
            type="number"
            min={1}
            max={99}
            step={1}
            value={values.priority}
            onChange={(event) => update({ priority: event.target.value })}
            className={`${fieldClass} w-20`}
          />
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs text-neutral-600">
          <input
            ref={activeRef}
            type="checkbox"
            name="active"
            checked={values.active}
            onChange={(event) => update({ active: event.target.checked })}
          />
          Active
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {editing ? 'Save changes' : 'Create target'}
        </button>
        {editing ? (
          <Link href="/targets" className="px-1 py-1.5 text-xs text-neutral-500 hover:text-neutral-900">
            Cancel
          </Link>
        ) : null}
      </div>
      <p className="text-[11px] text-neutral-500">
        A target matches a deal when the deal&apos;s vendor is the chosen vendor, or when its title
        or summary contains the keyword. At least one of the two is required.
      </p>
      {state.error ? (
        <p aria-live="polite" className="rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
