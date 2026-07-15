import {
  IconAlertTriangle,
  IconBan,
  IconInfoCircle,
} from "@tabler/icons-react";
import type { ImportIssue, ImportIssueLevel } from "@mini-infra/types";

/**
 * The report both on-ramps share — Docker Compose import and template
 * export/import. Compose is a bigger surface than a stack template, and an
 * export can't carry secrets or origin-instance state, so both leave things
 * behind. This renders exactly what, grouped by how much the user needs to
 * care, so nothing is dropped in silence.
 */
const LEVEL_META: Record<
  ImportIssueLevel,
  { label: string; icon: typeof IconBan; className: string }
> = {
  error: {
    label: "Blocking",
    icon: IconBan,
    className: "text-destructive",
  },
  unsupported: {
    label: "Not imported",
    icon: IconAlertTriangle,
    className: "text-amber-600 dark:text-amber-400",
  },
  lossy: {
    label: "Changed",
    icon: IconAlertTriangle,
    className: "text-amber-600 dark:text-amber-400",
  },
  defaulted: {
    label: "Assumed",
    icon: IconInfoCircle,
    className: "text-muted-foreground",
  },
};

const LEVEL_ORDER: ImportIssueLevel[] = ["error", "unsupported", "lossy", "defaulted"];

export function ImportIssueList({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return null;

  return (
    <div className="max-h-56 space-y-3 overflow-y-auto rounded-md border p-3">
      {LEVEL_ORDER.map((level) => {
        const forLevel = issues.filter((i) => i.level === level);
        if (forLevel.length === 0) return null;
        const meta = LEVEL_META[level];
        const Icon = meta.icon;

        return (
          <div key={level}>
            <div
              className={`mb-1 flex items-center gap-1.5 text-sm font-medium ${meta.className}`}
            >
              <Icon className="h-4 w-4" />
              {meta.label}
              <span className="text-muted-foreground">({forLevel.length})</span>
            </div>
            <ul className="space-y-1">
              {forLevel.map((issue, i) => (
                <li key={`${issue.path}-${i}`} className="text-xs">
                  {issue.path && (
                    <code className="mr-1 rounded bg-muted px-1 py-0.5">{issue.path}</code>
                  )}
                  <span className="text-muted-foreground">{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
