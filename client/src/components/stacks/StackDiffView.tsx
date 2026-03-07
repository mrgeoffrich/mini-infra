import type { FieldDiff } from "@mini-infra/types";

interface StackDiffViewProps {
  diffs: FieldDiff[];
}

function formatValue(value: string | null): string {
  if (value === null) return "(none)";
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

export function StackDiffView({ diffs }: StackDiffViewProps) {
  if (diffs.length === 0) return null;

  return (
    <div className="rounded border bg-muted/50 overflow-y-auto">
      <div className="p-3">
        <pre className="text-xs font-mono whitespace-pre-wrap">
          {diffs.map((diff, index) => (
            <div key={index} className="mb-2 last:mb-0">
              <div className="font-semibold text-muted-foreground">
                {diff.field}
              </div>
              {diff.old !== null && (
                <div className="bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 px-2 py-0.5 rounded-sm">
                  {"- "}
                  {formatValue(diff.old)}
                </div>
              )}
              {diff.new !== null && (
                <div className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-sm">
                  {"+ "}
                  {formatValue(diff.new)}
                </div>
              )}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
