import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  TestTube,
  X,
} from "lucide-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { TestResult } from "@/hooks/use-service-testing";

// ====================
// Test Results Panel Props
// ====================

export interface TestResultsPanelProps {
  testResults: TestResult | null;
  isTesting: boolean;
  onClearResults?: () => void;
  className?: string;
}

// ====================
// Status Icon Mapping
// ====================

const getStatusIcon = (isValid: boolean, isTesting: boolean) => {
  if (isTesting) {
    return <Loader2 className="h-5 w-5 animate-spin text-blue-600" />;
  }

  if (isValid) {
    return <CheckCircle className="h-5 w-5 text-green-600" />;
  }

  return <XCircle className="h-5 w-5 text-red-600" />;
};

const getStatusBadge = (isValid: boolean, isTesting: boolean) => {
  if (isTesting) {
    return (
      <Badge variant="outline" className="border-blue-200 text-blue-600">
        Testing...
      </Badge>
    );
  }

  if (isValid) {
    return (
      <Badge variant="default" className="bg-green-100 text-green-800 border-green-200">
        Passed
      </Badge>
    );
  }

  return (
    <Badge variant="destructive" className="bg-red-100 text-red-800 border-red-200">
      Failed
    </Badge>
  );
};

const getStatusBackground = (isValid: boolean, isTesting: boolean) => {
  if (isTesting) {
    return "bg-blue-50 border-blue-200";
  }

  if (isValid) {
    return "bg-green-50 border-green-200";
  }

  return "bg-red-50 border-red-200";
};

// ====================
// Test Results Panel Component
// ====================

export function TestResultsPanel({
  testResults,
  isTesting,
  onClearResults,
  className = "",
}: TestResultsPanelProps) {
  const { formatDateTime } = useFormattedDate();

  // Don't render if no test results and not currently testing
  if (!testResults && !isTesting) {
    return null;
  }

  const isValid = testResults?.isValid ?? false;
  const hasResults = testResults !== null;

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TestTube className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Test Results
            </CardTitle>
          </div>
          {hasResults && onClearResults && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearResults}
              className="h-auto p-1"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <CardDescription className="text-xs">
          {isTesting
            ? "Testing connection with current form values..."
            : "Results from testing connection (not saved configuration)"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isTesting ? (
          // Loading state
          <div className="p-4 rounded-md border bg-blue-50 border-blue-200">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              <Badge variant="outline" className="border-blue-200 text-blue-600">
                Testing...
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Validating connection with current form values
            </div>
          </div>
        ) : testResults ? (
          // Test results
          <div className={`p-4 rounded-md border ${getStatusBackground(isValid, false)}`}>
            <div className="flex items-center gap-2 mb-2">
              {getStatusIcon(isValid, false)}
              {getStatusBadge(isValid, false)}
            </div>

            {/* Response Time */}
            {testResults.responseTimeMs !== undefined && (
              <div className="text-sm text-muted-foreground mb-1">
                Response time: {testResults.responseTimeMs}ms
              </div>
            )}

            {/* Test Time */}
            <div className="text-xs text-muted-foreground mb-2">
              Tested: {formatDateTime(testResults.testedAt)}
            </div>

            {/* Error Message */}
            {!isValid && testResults.error && (
              <div className="text-sm text-red-600 mt-2 p-2 bg-red-50 rounded border border-red-100">
                <strong>Error:</strong> {testResults.error}
                {testResults.errorCode && (
                  <div className="text-xs mt-1 text-red-500">
                    Code: {testResults.errorCode}
                  </div>
                )}
              </div>
            )}

            {/* Success Metadata */}
            {isValid && testResults.metadata && (
              <div className="text-sm text-green-700 mt-2 p-2 bg-green-50 rounded border border-green-100">
                <strong>Connection details validated successfully</strong>
                {testResults.metadata.accountName && (
                  <div className="text-xs mt-1">
                    Account: {testResults.metadata.accountName}
                  </div>
                )}
              </div>
            )}

            {/* Warning about test-only nature */}
            <div className="mt-3 p-2 bg-amber-50 border border-amber-200 rounded">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-amber-700">
                  <strong>Test Only:</strong> These results are from testing your current form values.
                  Use the Save button to persist settings and update the actual connection status.
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ====================
// Compact Test Results Panel
// ====================

export interface CompactTestResultsPanelProps {
  testResults: TestResult | null;
  isTesting: boolean;
  className?: string;
}

export function CompactTestResultsPanel({
  testResults,
  isTesting,
  className = "",
}: CompactTestResultsPanelProps) {
  // Don't render if no test results and not currently testing
  if (!testResults && !isTesting) {
    return null;
  }

  const isValid = testResults?.isValid ?? false;

  return (
    <div className={`flex items-center gap-2 text-sm ${className}`}>
      {isTesting ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
          <span className="text-blue-600">Testing connection...</span>
        </>
      ) : testResults ? (
        <>
          {getStatusIcon(isValid, false)}
          <span className={isValid ? "text-green-600" : "text-red-600"}>
            Test {isValid ? "passed" : "failed"}
            {testResults.responseTimeMs && ` (${testResults.responseTimeMs}ms)`}
          </span>
        </>
      ) : null}
    </div>
  );
}