import type { Category, TargetRow } from '@/lib/types';

/** The form's own field state. Values are strings because every control maps to FormData. */
export interface TargetFormValues {
  vendor_id: string;
  keyword: string;
  max_price: string;
  priority: string;
  active: boolean;
}

/** Return shape of the create/update Server Actions, consumed by `useActionState`. */
export interface TargetFormState {
  error: string | null;
}

export const EMPTY_TARGET_FORM_STATE: TargetFormState = { error: null };

/** The slice of `vendor` the target form's dropdown needs. */
export interface VendorOption {
  id: number;
  name: string;
  category: Category;
  tier: number;
}

export interface TargetFormProps {
  action: (state: TargetFormState, formData: FormData) => Promise<TargetFormState>;
  vendors: VendorOption[];
  /** The row being edited, or null when creating. */
  target: TargetRow | null;
}
