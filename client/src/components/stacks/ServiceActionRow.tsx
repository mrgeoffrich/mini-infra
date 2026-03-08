import React from "react";
import {
  IconPlus,
  IconRotateClockwise2,
  IconTrash,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { StackDiffView } from "./StackDiffView";
import type { ServiceAction } from "@mini-infra/types";

interface ServiceActionRowProps {
  action: ServiceAction;
  selected?: boolean;
  onSelect?: (serviceName: string, selected: boolean) => void;
  showCheckbox?: boolean;
}

const actionConfig = {
  create: {
    icon: IconPlus,
    label: "Create",
    badgeClass: "bg-green-500 text-white hover:bg-green-600",
    iconClass: "text-green-500",
  },
  recreate: {
    icon: IconRotateClockwise2,
    label: "Recreate",
    badgeClass: "bg-orange-500 text-white hover:bg-orange-600",
    iconClass: "text-orange-500",
  },
  remove: {
    icon: IconTrash,
    label: "Remove",
    badgeClass: "bg-red-500 text-white hover:bg-red-600",
    iconClass: "text-red-500",
  },
  "no-op": {
    icon: IconCheck,
    label: "No Change",
    badgeClass: "",
    iconClass: "text-muted-foreground",
  },
} as const;

export const ServiceActionRow = React.memo(function ServiceActionRow({
  action,
  selected,
  onSelect,
  showCheckbox,
}: ServiceActionRowProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const config = actionConfig[action.action];
  const Icon = config.icon;
  const hasDiff = action.diff && action.diff.length > 0;

  return (
    <div className="flex items-start gap-3 py-3">
      {showCheckbox && action.action !== "no-op" && (
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) =>
            onSelect?.(action.serviceName, !!checked)
          }
          className="mt-1"
        />
      )}
      {showCheckbox && action.action === "no-op" && (
        <div className="w-4" />
      )}

      <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${config.iconClass}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-medium truncate">{action.serviceName}</span>
            {action.currentImage && action.desiredImage && action.currentImage !== action.desiredImage && (
              <span className="text-xs text-muted-foreground truncate">
                {action.currentImage} {"->"}  {action.desiredImage}
              </span>
            )}
          </div>

          <Badge
            variant={action.action === "no-op" ? "secondary" : "default"}
            className={config.badgeClass}
          >
            {config.label}
          </Badge>
        </div>

        {action.reason && (
          <p className="text-sm text-muted-foreground mt-1">{action.reason}</p>
        )}

        {hasDiff && (
          <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="p-1 h-auto text-xs mt-1"
              >
                {isExpanded ? (
                  <IconChevronUp className="h-3 w-3 mr-1" />
                ) : (
                  <IconChevronDown className="h-3 w-3 mr-1" />
                )}
                {isExpanded ? "Hide Diff" : "Show Diff"}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2">
                <StackDiffView diffs={action.diff!} />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
});
