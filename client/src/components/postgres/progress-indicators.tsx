import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Activity, History, Zap, Database, Eye, EyeOff } from "lucide-react";
import {
  ActiveOperationsDisplay,
  ActiveOperationsIndicator,
} from "./active-operations-display";
import { OperationHistoryList } from "./operation-history-list";
import { useActiveOperationsStatus } from "@/hooks/use-postgres-progress";

interface ProgressIndicatorsProps {
  databaseId?: string;
  showDatabaseSelector?: boolean;
  defaultTab?: "active" | "history";
  onCancelOperation?: (operationId: string) => void;
  className?: string;
}

export function ProgressIndicators({
  databaseId,
  defaultTab = "active",
  onCancelOperation,
  className,
}: ProgressIndicatorsProps) {
  const [activeTab, setActiveTab] = useState<"active" | "history">(defaultTab);
  const { hasAnyActive, totalActiveCount } = useActiveOperationsStatus();

  return (
    <div className={className}>
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "active" | "history")} className="w-full">
        <div className="flex items-center justify-between mb-4">
          <TabsList className="grid w-auto grid-cols-2">
            <TabsTrigger value="active" className="flex items-center space-x-2">
              <Activity className="w-4 h-4" />
              <span>Active Operations</span>
              {hasAnyActive && (
                <Badge variant="outline" className="ml-1 text-xs">
                  {totalActiveCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="flex items-center space-x-2"
            >
              <History className="w-4 h-4" />
              <span>History</span>
            </TabsTrigger>
          </TabsList>

          {/* Global Active Operations Indicator */}
          <ActiveOperationsIndicator />
        </div>

        <TabsContent value="active" className="mt-0">
          <ActiveOperationsDisplay
            databaseId={databaseId}
            showHeader={false}
            onCancelOperation={onCancelOperation}
            maxHeight="500px"
          />
        </TabsContent>

        <TabsContent value="history" className="mt-0">
          <OperationHistoryList
            databaseId={databaseId}
            showDatabaseFilter={!databaseId}
            maxHeight="500px"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface CompactProgressIndicatorProps {
  databaseId?: string;
  onCancelOperation?: (operationId: string) => void;
  className?: string;
}

export function CompactProgressIndicator({
  databaseId,
  onCancelOperation,
  className,
}: CompactProgressIndicatorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { hasAnyActive, totalActiveCount } = useActiveOperationsStatus();

  if (!hasAnyActive) {
    return null;
  }

  return (
    <div className={className}>
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Activity className="w-5 h-5 text-blue-600" />
              <CardTitle className="text-sm font-medium">
                {totalActiveCount} Active Operation
                {totalActiveCount !== 1 ? "s" : ""}
              </CardTitle>
              <Badge
                variant="outline"
                className="text-blue-700 border-blue-200"
              >
                <Zap className="w-3 h-3 mr-1" />
                Live
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </Button>
          </div>
        </CardHeader>

        {isExpanded && (
          <CardContent className="pt-0">
            <ActiveOperationsDisplay
              databaseId={databaseId}
              showHeader={false}
              onCancelOperation={onCancelOperation}
              maxHeight="300px"
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}

interface DatabaseProgressIndicatorProps {
  databaseId: string;
  databaseName?: string;
  showHistory?: boolean;
  onCancelOperation?: (operationId: string) => void;
  className?: string;
}

export function DatabaseProgressIndicator({
  databaseId,
  databaseName,
  showHistory = true,
  onCancelOperation,
  className,
}: DatabaseProgressIndicatorProps) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center">
            <Database className="w-5 h-5 mr-2" />
            {databaseName
              ? `${databaseName} Operations`
              : "Database Operations"}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDetails(!showDetails)}
          >
            {showDetails ? "Hide Details" : "Show Details"}
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <div className="space-y-4">
          {/* Always show active operations */}
          <ActiveOperationsDisplay
            databaseId={databaseId}
            showHeader={false}
            onCancelOperation={onCancelOperation}
            maxHeight="200px"
          />

          {/* Show history if requested and details are expanded */}
          {showHistory && showDetails && (
            <OperationHistoryList
              databaseId={databaseId}
              showDatabaseFilter={false}
              maxHeight="300px"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export { ActiveOperationsIndicator } from "./active-operations-display";
