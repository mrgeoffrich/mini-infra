/**
 * EgressPromoteWizard — multi-step modal to transition an egress policy
 * from "detect" to "enforce" mode.
 *
 * Step 1 — Review observed traffic (last 7 days, grouped by destination)
 * Step 2 — Suggested wildcard collapses + uncovered destinations
 * Step 3 — Confirm: summary, defaultAction override, progress during submit
 */

import { useState, useMemo } from "react";
import { toast } from "sonner";
import {
  IconChevronRight,
  IconChevronLeft,
  IconLoader2,
  IconCheck,
  IconX,
  IconAlertCircle,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useCreateEgressRule, usePatchEgressPolicy } from "@/hooks/use-egress";
import { listEgressEventsForPolicy } from "@/api/egress";
import {
  computeWildcardSuggestions,
  type WildcardSuggestion,
} from "@/lib/egress-wildcard-suggestions";
import type { EgressRuleSummary, EgressDefaultAction } from "@mini-infra/types";
import { useQuery } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UncoveredDestination {
  destination: string;
  count: number;
  action: "allow" | "block";
  selected: boolean;
}

interface SuggestionRow {
  suggestion: WildcardSuggestion;
  accepted: boolean;
  expanded: boolean;
  count: number;
}

interface EgressPromoteWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policyId: string;
  existingRules: EgressRuleSummary[];
  onSuccess?: () => void;
}

// ---------------------------------------------------------------------------
// Step 1 — Traffic review
// ---------------------------------------------------------------------------

function since7d(): string {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

interface Step1Props {
  policyId: string;
  existingRules: EgressRuleSummary[];
  destinationCounts: Map<string, number>;
  isLoading: boolean;
  isError: boolean;
}

function Step1Review({
  existingRules,
  destinationCounts,
  isLoading,
  isError,
}: Step1Props) {
  const existingPatterns = existingRules.map((r) => r.pattern);

  function isCovered(dest: string): boolean {
    return existingPatterns.some((rule) => {
      if (rule === dest) return true;
      if (rule.startsWith("*.")) {
        const suffix = rule.slice(2);
        return dest === suffix || dest.endsWith(`.${suffix}`);
      }
      return false;
    });
  }

  const sorted = Array.from(destinationCounts.entries()).sort(
    ([, a], [, b]) => b - a,
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>Failed to load traffic events.</AlertDescription>
      </Alert>
    );
  }

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic py-4 text-center">
        No observed traffic in the last 7 days. You can still promote to Enforce,
        but no rules will be suggested.
      </p>
    );
  }

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
      {sorted.map(([dest, count]) => (
        <div
          key={dest}
          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
        >
          <span className="font-mono text-xs truncate flex-1">{dest}</span>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-muted-foreground text-xs">{count} hits</span>
            {isCovered(dest) ? (
              <Badge
                variant="outline"
                className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
              >
                <IconCheck className="h-3 w-3 mr-1" />
                Covered
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300"
              >
                Uncovered
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Wildcard suggestions
// ---------------------------------------------------------------------------

interface Step2Props {
  suggestionRows: SuggestionRow[];
  uncoveredRows: UncoveredDestination[];
  onToggleSuggestion: (idx: number) => void;
  onExpandSuggestion: (idx: number) => void;
  onToggleUncovered: (idx: number) => void;
  onChangeUncoveredAction: (idx: number, action: "allow" | "block") => void;
}

function Step2Suggestions({
  suggestionRows,
  uncoveredRows,
  onToggleSuggestion,
  onExpandSuggestion,
  onToggleUncovered,
  onChangeUncoveredAction,
}: Step2Props) {
  return (
    <div className="space-y-5">
      {/* Wildcard proposals */}
      {suggestionRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Suggested wildcard rules ({suggestionRows.length})
          </p>
          <p className="text-xs text-muted-foreground">
            These wildcards cover 3+ observed destinations under the same domain.
          </p>
          <div className="space-y-2">
            {suggestionRows.map((row, idx) => (
              <div key={row.suggestion.pattern} className="rounded-md border">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Checkbox
                    id={`sug-${idx}`}
                    checked={row.accepted}
                    onCheckedChange={() => onToggleSuggestion(idx)}
                  />
                  <Label
                    htmlFor={`sug-${idx}`}
                    className="font-mono text-xs flex-1 cursor-pointer"
                  >
                    {row.suggestion.pattern}
                  </Label>
                  <Badge
                    variant="outline"
                    className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
                  >
                    allow
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {row.suggestion.covers.length} dest
                    {row.suggestion.covers.length !== 1 ? "s" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => onExpandSuggestion(idx)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {row.expanded ? (
                      <IconChevronUp className="h-4 w-4" />
                    ) : (
                      <IconChevronDown className="h-4 w-4" />
                    )}
                  </button>
                </div>
                {row.expanded && (
                  <div className="border-t bg-muted/30 px-4 py-2 space-y-1">
                    {row.suggestion.covers.map((c) => (
                      <p key={c} className="font-mono text-xs text-muted-foreground">
                        {c}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Uncovered destinations */}
      {uncoveredRows.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Additional destinations ({uncoveredRows.length})
          </p>
          <p className="text-xs text-muted-foreground">
            These destinations were not collapsed into a wildcard and are not
            already covered by an existing rule.
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {uncoveredRows.map((row, idx) => (
              <div
                key={row.destination}
                className="flex items-center gap-2 rounded-md border px-3 py-2"
              >
                <Checkbox
                  id={`unc-${idx}`}
                  checked={row.selected}
                  onCheckedChange={() => onToggleUncovered(idx)}
                />
                <Label
                  htmlFor={`unc-${idx}`}
                  className="font-mono text-xs flex-1 cursor-pointer"
                >
                  {row.destination}
                </Label>
                <span className="text-muted-foreground text-xs">
                  {row.count} hits
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={row.action}
                  onValueChange={(v) => {
                    if (v) onChangeUncoveredAction(idx, v as "allow" | "block");
                  }}
                  className="h-7"
                >
                  <ToggleGroupItem value="allow" className="h-6 text-xs px-2">
                    Allow
                  </ToggleGroupItem>
                  <ToggleGroupItem value="block" className="h-6 text-xs px-2">
                    Block
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            ))}
          </div>
        </div>
      )}

      {suggestionRows.length === 0 && uncoveredRows.length === 0 && (
        <p className="text-sm text-muted-foreground italic py-4 text-center">
          No new rules to suggest — all observed traffic is already covered by
          existing rules.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Confirm
// ---------------------------------------------------------------------------

interface Step3Props {
  totalNewRules: number;
  defaultAction: EgressDefaultAction;
  onChangeDefaultAction: (a: EgressDefaultAction) => void;
  progress: { done: number; total: number } | null;
  error: string | null;
}

function Step3Confirm({
  totalNewRules,
  defaultAction,
  onChangeDefaultAction,
  progress,
  error,
}: Step3Props) {
  return (
    <div className="space-y-5">
      <div className="rounded-md border divide-y">
        <div className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="text-muted-foreground">New rules to create</span>
          <span className="font-medium">{totalNewRules}</span>
        </div>
        <div className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="text-muted-foreground">Mode will change to</span>
          <Badge
            variant="outline"
            className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300"
          >
            Enforce
          </Badge>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Default action</p>
        <p className="text-xs text-muted-foreground">
          Traffic that doesn&apos;t match any rule will be handled by this
          default. "Block" is the standard enforce posture.
        </p>
        <ToggleGroup
          type="single"
          variant="outline"
          value={defaultAction}
          onValueChange={(v) => {
            if (v) onChangeDefaultAction(v as EgressDefaultAction);
          }}
          className="w-full"
          disabled={!!progress}
        >
          <ToggleGroupItem value="block" className="flex-1">
            Block (recommended)
          </ToggleGroupItem>
          <ToggleGroupItem value="allow" className="flex-1">
            Allow
          </ToggleGroupItem>
        </ToggleGroup>
        {defaultAction === "block" && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Traffic without an explicit allow rule will be blocked. Confirm that
            all required destinations are covered above.
          </p>
        )}
      </div>

      {/* Progress during submit */}
      {progress && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm">
            <IconLoader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span>
              Creating rules: {progress.done} / {progress.total}
            </span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{
                width: `${
                  progress.total > 0
                    ? (progress.done / progress.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export function EgressPromoteWizard({
  open,
  onOpenChange,
  policyId,
  existingRules,
  onSuccess,
}: EgressPromoteWizardProps) {
  const [step, setStep] = useState(0);
  const [suggestionRows, setSuggestionRows] = useState<SuggestionRow[]>([]);
  const [uncoveredRows, setUncoveredRows] = useState<UncoveredDestination[]>([]);
  const [defaultAction, setDefaultAction] = useState<EgressDefaultAction>("block");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [suggestionsInitialised, setSuggestionsInitialised] = useState(false);

  const createRule = useCreateEgressRule();
  const patchPolicy = usePatchEgressPolicy();

  // Fetch last 7 days of events for this policy. 200 is the server's
  // hard cap on `limit`; events are deduplicated server-side per
  // (destination, pattern) with mergedHits, so 200 rows comfortably
  // covers the unique destinations a wizard run needs to consider.
  const eventsQuery = useQuery({
    queryKey: ["egressEvents", "wizard", policyId],
    queryFn: () =>
      listEgressEventsForPolicy(policyId, { since: since7d(), limit: 200 }),
    enabled: open,
    staleTime: 30000,
  });

  // Build destination counts map
  const destinationCounts = useMemo<Map<string, number>>(() => {
    const events = eventsQuery.data?.events ?? [];
    const map = new Map<string, number>();
    for (const evt of events) {
      if (!evt.destination) continue;
      map.set(evt.destination, (map.get(evt.destination) ?? 0) + evt.mergedHits);
    }
    return map;
  }, [eventsQuery.data]);

  // Compute suggestions lazily when the user moves from step 0 to step 1.
  // This runs inside a click handler (not an effect or render path) so the
  // react-hooks/set-state-in-effect lint rule doesn't flag it.
  function ensureSuggestionsInitialised() {
    if (suggestionsInitialised) return;

    const destinations = Array.from(destinationCounts.keys());
    const existingPatterns = existingRules.map((r) => r.pattern);
    const { suggestions, uncovered } = computeWildcardSuggestions(
      destinations,
      existingPatterns,
    );

    setSuggestionRows(
      suggestions.map((s) => ({
        suggestion: s,
        accepted: true,
        expanded: false,
        count: s.covers.reduce((sum, d) => sum + (destinationCounts.get(d) ?? 0), 0),
      })),
    );

    setUncoveredRows(
      uncovered.map((d) => ({
        destination: d,
        count: destinationCounts.get(d) ?? 0,
        action: "allow",
        selected: true,
      })),
    );

    setSuggestionsInitialised(true);
  }

  // Total new rules = accepted wildcards + selected uncovered destinations
  const totalNewRules =
    suggestionRows.filter((r) => r.accepted).length +
    uncoveredRows.filter((r) => r.selected).length;

  const handleClose = (o: boolean) => {
    if (!o) {
      setStep(0);
      setSuggestionsInitialised(false);
      setProgress(null);
      setSubmitError(null);
      setDefaultAction("block");
    }
    onOpenChange(o);
  };

  const handleSubmit = async () => {
    const rulesToCreate: Array<{ pattern: string; action: "allow" | "block" }> = [
      ...suggestionRows
        .filter((r) => r.accepted)
        .map((r) => ({ pattern: r.suggestion.pattern, action: "allow" as const })),
      ...uncoveredRows
        .filter((r) => r.selected)
        .map((r) => ({ pattern: r.destination, action: r.action })),
    ];

    setProgress({ done: 0, total: rulesToCreate.length });
    setSubmitError(null);

    for (let i = 0; i < rulesToCreate.length; i++) {
      try {
        await createRule.mutateAsync({
          policyId,
          body: { ...rulesToCreate[i], targets: [] },
        });
        setProgress({ done: i + 1, total: rulesToCreate.length });
      } catch (err) {
        setSubmitError(
          `Failed to create rule "${rulesToCreate[i].pattern}": ${
            err instanceof Error ? err.message : "Unknown error"
          }. Remaining rules were not created.`,
        );
        return; // halt — don't flip mode
      }
    }

    // All rules created — flip the policy mode
    try {
      await patchPolicy.mutateAsync({
        policyId,
        body: { mode: "enforce", defaultAction },
      });
      toast.success("Policy promoted to Enforce mode");
      handleClose(false);
      onSuccess?.();
    } catch (err) {
      setSubmitError(
        `Rules were created but failed to switch mode to Enforce: ${
          err instanceof Error ? err.message : "Unknown error"
        }`,
      );
    }
  };

  const STEPS = ["Review Traffic", "Suggest Rules", "Confirm"];
  const isSubmitting = !!progress;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Promote to Enforce</DialogTitle>
          <DialogDescription>
            Review observed traffic, accept rule suggestions, then switch this
            policy to Enforce mode.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          {STEPS.map((label, i) => (
            <span key={label} className="flex items-center gap-1">
              {i > 0 && <IconChevronRight className="h-3 w-3" />}
              <span
                className={
                  i === step
                    ? "font-medium text-foreground"
                    : i < step
                    ? "text-green-600 dark:text-green-400"
                    : ""
                }
              >
                {i < step ? <IconCheck className="h-3 w-3 inline mr-0.5" /> : `${i + 1}.`} {label}
              </span>
            </span>
          ))}
        </div>

        {/* Step content */}
        <div className="min-h-[200px]">
          {step === 0 && (
            <Step1Review
              policyId={policyId}
              existingRules={existingRules}
              destinationCounts={destinationCounts}
              isLoading={eventsQuery.isLoading}
              isError={eventsQuery.isError}
            />
          )}
          {step === 1 && (
            <Step2Suggestions
              suggestionRows={suggestionRows}
              uncoveredRows={uncoveredRows}
              onToggleSuggestion={(idx) =>
                setSuggestionRows((rows) =>
                  rows.map((r, i) =>
                    i === idx ? { ...r, accepted: !r.accepted } : r,
                  ),
                )
              }
              onExpandSuggestion={(idx) =>
                setSuggestionRows((rows) =>
                  rows.map((r, i) =>
                    i === idx ? { ...r, expanded: !r.expanded } : r,
                  ),
                )
              }
              onToggleUncovered={(idx) =>
                setUncoveredRows((rows) =>
                  rows.map((r, i) =>
                    i === idx ? { ...r, selected: !r.selected } : r,
                  ),
                )
              }
              onChangeUncoveredAction={(idx, action) =>
                setUncoveredRows((rows) =>
                  rows.map((r, i) => (i === idx ? { ...r, action } : r)),
                )
              }
            />
          )}
          {step === 2 && (
            <Step3Confirm
              totalNewRules={totalNewRules}
              defaultAction={defaultAction}
              onChangeDefaultAction={setDefaultAction}
              progress={progress}
              error={submitError}
            />
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (step === 0) {
                handleClose(false);
              } else {
                setStep((s) => s - 1);
              }
            }}
            disabled={isSubmitting}
          >
            {step === 0 ? (
              <>
                <IconX className="h-4 w-4 mr-1" />
                Cancel
              </>
            ) : (
              <>
                <IconChevronLeft className="h-4 w-4 mr-1" />
                Back
              </>
            )}
          </Button>

          {step < 2 ? (
            <Button
              onClick={() => {
                // Initialise suggestions lazily when advancing to step 1
                if (step === 0) ensureSuggestionsInitialised();
                setStep((s) => s + 1);
              }}
              disabled={eventsQuery.isLoading}
            >
              Next
              <IconChevronRight className="h-4 w-4 ml-1" />
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  Promoting...
                </>
              ) : (
                "Promote to Enforce"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
