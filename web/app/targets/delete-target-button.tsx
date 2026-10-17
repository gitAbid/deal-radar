'use client';

/**
 * Confirmation guard for the one destructive action on /targets. Without
 * JavaScript the confirm is skipped but the plain POST still works.
 */
export function DeleteTargetButton() {
  return (
    <button
      type="submit"
      className="text-red-700 hover:underline"
      onClick={(event) => {
        if (
          !window.confirm(
            'Delete this target? Only the target row is removed — deals and vendor rows are untouched.',
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      Delete
    </button>
  );
}
