import type { PrerequisiteEvaluation, HelpAction } from "@mini-infra/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";

interface PrerequisitesBannerProps {
  evaluation: PrerequisiteEvaluation;
  /** "blocked" → variant=destructive, "warning" → default. The stack
   *  detail surface uses blocked (apply is disabled until satisfied);
   *  the instantiate dialog uses warning (still allowed to proceed). */
  severity: "blocked" | "warning";
  /** Optional title override; defaults to a sensible per-severity label. */
  title?: string;
  className?: string;
}

/**
 * Renders the cross-stack prereq evaluation result. Hidden when
 * `evaluation.ok` is true. Each failure deep-links via its `helpAction`
 * — clicking opens the Vault bootstrap page or the catalog filtered to
 * the missing template, depending on the action type.
 */
export function PrerequisitesBanner({
  evaluation,
  severity,
  title,
  className,
}: PrerequisitesBannerProps) {
  if (evaluation.ok) return null;

  const variant = severity === "blocked" ? "destructive" : "default";
  const defaultTitle =
    severity === "blocked"
      ? "Apply is blocked — prerequisites not met"
      : "Some prerequisites aren't met yet";

  return (
    <Alert variant={variant} className={className} data-testid="prereqs-banner">
      <IconAlertTriangle className="h-4 w-4" />
      <AlertTitle>{title ?? defaultTitle}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 space-y-1.5 list-disc pl-5">
          {evaluation.failures.map((failure, idx) => (
            <li key={idx} className="text-sm">
              <span>{failure.reason}</span>{" "}
              <HelpActionLink helpAction={failure.helpAction} />
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function HelpActionLink({ helpAction }: { helpAction: HelpAction | undefined }) {
  if (!helpAction) return null;
  const href = helpActionHref(helpAction);
  const label = helpActionLabel(helpAction);
  if (!href) return null;
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline ml-1"
    >
      {label}
      <IconExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

/**
 * Map a `HelpAction` to a navigation href. Kept open-coded rather than
 * delegated to react-router because the existing Mini Infra app uses
 * vanilla anchors for cross-page navigation; this matches the local
 * convention. Phase 1 supports three actions; extend here when more
 * are introduced.
 */
function helpActionHref(action: HelpAction): string | null {
  switch (action.type) {
    case "open-vault-bootstrap":
      return "/vault";
    case "instantiate-stack":
    case "apply-stack":
      // Catalog page filtered by template name. The catalog page's URL
      // does not yet support a per-template deep-link; sending the
      // user to the host catalog with a query param is a graceful
      // best-effort and is the right place to find the missing stack.
      return action.scopeMatch === "host"
        ? `/?template=${encodeURIComponent(action.templateName)}`
        : `/environments?template=${encodeURIComponent(action.templateName)}`;
    default:
      return null;
  }
}

function helpActionLabel(action: HelpAction): string {
  switch (action.type) {
    case "open-vault-bootstrap":
      return "Bootstrap Vault";
    case "instantiate-stack":
      return `Deploy '${action.templateName}'`;
    case "apply-stack":
      return `Apply '${action.templateName}'`;
    default:
      return "Resolve";
  }
}

