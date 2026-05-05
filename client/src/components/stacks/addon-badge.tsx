import { IconPuzzle } from "@tabler/icons-react";

/**
 * Marker pill shown on synthetic services materialised by the Service Addons
 * render pipeline (Phase 3+). The visual language deliberately mirrors the
 * existing amber `Pool` and blue self-role pills in the Containers page —
 * one consistent treatment across the Stack-detail services table and the
 * Containers page so an operator who sees the violet `IconPuzzle` pill on
 * one surface recognises it instantly on the other.
 *
 * The optional `targetName` back-reference is rendered only when supplied.
 * When `onTargetClick` is also passed, it renders as a button the operator
 * can click to navigate to the target row (used on the Containers page,
 * where target and synthetic rows are on different routes); otherwise it's
 * plain text (used on the Stack-detail page, where both rows are on the
 * same view).
 */
export function AddonBadge({
  addonName,
  targetName,
  onTargetClick,
}: {
  addonName: string;
  targetName?: string;
  onTargetClick?: () => void;
}) {
  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 text-xs bg-violet-100 dark:bg-violet-900 text-violet-800 dark:text-violet-200 px-1.5 py-0.5 rounded"
      title={`Provisioned by the ${addonName} addon${
        targetName ? ` attached to ${targetName}` : ""
      }`}
    >
      <IconPuzzle className="h-3 w-3" aria-hidden="true" />
      <span>from {addonName}</span>
      {targetName ? (
        onTargetClick ? (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTargetClick();
              }}
              className="underline-offset-2 hover:underline"
            >
              {targetName}
            </button>
          </>
        ) : (
          <span aria-hidden="true">· {targetName}</span>
        )
      ) : null}
    </span>
  );
}
