import { IconMinus, IconPlus, IconPencil } from "@tabler/icons-react";
import { StackDiffView } from "@/components/stacks/StackDiffView";
import { computeTemplateVersionDiff } from "@/lib/template-version-diff";
import type { StackTemplateVersionInfo } from "@mini-infra/types";

interface TemplateVersionDiffProps {
  /** The older version (baseline). */
  from: StackTemplateVersionInfo | null | undefined;
  /** The newer version being compared. */
  to: StackTemplateVersionInfo | null | undefined;
  /** Copy shown when there are no differences. */
  emptyLabel?: string;
}

/**
 * Renders a computed version-to-version diff: services added / removed /
 * changed (each changed service showing its field-level `FieldDiff`s via the
 * shared `StackDiffView`), plus template-level configuration changes. Used on
 * the template detail page (compare selected vs previous) and in the publish
 * dialog (draft vs current published).
 */
export function TemplateVersionDiff({ from, to, emptyLabel }: TemplateVersionDiffProps) {
  const diff = computeTemplateVersionDiff(from, to);

  if (!diff.hasChanges) {
    return (
      <p className="text-sm text-muted-foreground" data-tour="template-version-diff">
        {emptyLabel ?? "No differences between these versions."}
      </p>
    );
  }

  return (
    <div className="space-y-4 text-sm" data-tour="template-version-diff">
      {diff.servicesAdded.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 font-medium text-green-700 dark:text-green-400">
            <IconPlus className="h-4 w-4" />
            Services added
          </div>
          <ul className="list-disc space-y-0.5 pl-6">
            {diff.servicesAdded.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      {diff.servicesRemoved.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 font-medium text-red-700 dark:text-red-400">
            <IconMinus className="h-4 w-4" />
            Services removed
          </div>
          <ul className="list-disc space-y-0.5 pl-6">
            {diff.servicesRemoved.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      )}

      {diff.servicesChanged.map((change) => (
        <div key={change.serviceName}>
          <div className="mb-1 flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
            <IconPencil className="h-4 w-4" />
            {change.serviceName} changed
          </div>
          <div className="rounded-md border p-3">
            <StackDiffView diffs={change.fields} />
          </div>
        </div>
      ))}

      {diff.meta.length > 0 && (
        <div>
          <div className="mb-1 font-medium">Configuration changed</div>
          <div className="rounded-md border p-3">
            <StackDiffView diffs={diff.meta} />
          </div>
        </div>
      )}
    </div>
  );
}
