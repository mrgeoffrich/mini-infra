import { useNavigate } from "react-router-dom";
import { IconTerminal, IconChevronRight } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Phase 6 of the Claude Shell plan — the Applications-page presets row.
 *
 * Presets are curated "one click → tile-driven create form" entry points that
 * sit beside the generic "New Application" button. They differ from a
 * template in the catalog because they encode opinionated *form fields* (e.g.
 * "git repo URL + deploy-key paste-box") rather than a static blueprint.
 *
 * The shape is deliberately a single small file rather than a generic
 * `<PresetTile>` factory: presets aren't fungible — each one has different
 * inputs and routes to a different create page — and keeping the JSX inline
 * costs less than introducing an abstraction we'd have to bend the first
 * time the second preset has a different field set.
 */
export function PresetsSection() {
  const navigate = useNavigate();

  return (
    <div className="px-4 lg:px-6">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Presets
          </h2>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card
          role="button"
          tabIndex={0}
          aria-label="Create Claude Shell"
          data-tour="claude-shell-preset-tile"
          className="cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => navigate("/applications/new/claude-shell")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              navigate("/applications/new/claude-shell");
            }
          }}
        >
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
                  <IconTerminal className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Claude Shell</CardTitle>
                  <CardDescription className="mt-1">
                    Developer container with Claude Code, accessible via
                    Tailscale SSH.
                  </CardDescription>
                </div>
              </div>
              <IconChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">
              Persists workspace + <code>claude login</code> across restarts.
              Optional private repo via SSH deploy key.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
