'use client';

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const message = describe(error ?? 'Unknown error');
  const digest =
    error instanceof Error && 'digest' in error
      ? String((error as { digest?: unknown }).digest ?? '')
      : '';

  return (
    <div className="mx-auto mt-10 max-w-xl rounded border border-red-200 bg-white p-5">
      <h1 className="text-sm font-semibold text-red-700">Something went wrong</h1>
      <p className="mt-2 text-xs text-neutral-600">
        Deal Radar could not render this page. The most likely cause is that the database is
        unreachable or a query failed.
      </p>
      <p className="mt-2 break-words rounded bg-neutral-50 px-2 py-1.5 font-mono text-[11px] text-neutral-700">
        {message}
        {digest ? ` (digest ${digest})` : ''}
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700"
      >
        Try again
      </button>
    </div>
  );
}
