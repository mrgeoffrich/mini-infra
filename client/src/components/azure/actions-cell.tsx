import React from "react";
import { Button } from "@/components/ui/button";
import {
  IconCloudQuestion,
  IconLoader2,
  IconCircleCheck,
  IconCircleX,
} from "@tabler/icons-react";
import type { ContainerAccessTest } from "./types";

export const ActionsCell = React.memo(
  ({
    containerName,
    testStatus,
    onTestAccess,
  }: {
    containerName: string;
    testStatus?: ContainerAccessTest;
    onTestAccess: (containerName: string) => void;
  }) => {
    const isTestActive = testStatus?.status === "testing";
    const hasResult =
      testStatus?.status === "success" || testStatus?.status === "failed";

    return (
      <div className="flex items-center gap-2 min-h-[2rem]">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onTestAccess(containerName)}
          disabled={isTestActive}
          className="h-8 px-3"
        >
          {isTestActive ? (
            <IconLoader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <IconCloudQuestion className="h-3 w-3 mr-1" />
          )}
          Test Access
        </Button>
        {hasResult && (
          <div className="flex items-center gap-1">
            {testStatus?.status === "success" ? (
              <div title="Access successful">
                <IconCircleCheck className="h-4 w-4 text-green-600" />
              </div>
            ) : (
              <div title={testStatus?.error || "Access failed"}>
                <IconCircleX className="h-4 w-4 text-red-600" />
              </div>
            )}
            {testStatus?.responseTime && (
              <span
                className="text-xs text-muted-foreground"
                title="Response time"
              >
                {testStatus.responseTime}ms
              </span>
            )}
          </div>
        )}
      </div>
    );
  },
  (prevProps, nextProps) =>
    prevProps.containerName === nextProps.containerName &&
    JSON.stringify(prevProps.testStatus) ===
      JSON.stringify(nextProps.testStatus),
);

ActionsCell.displayName = "ActionsCell";
