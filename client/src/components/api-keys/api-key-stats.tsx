import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiKeyStats } from "@/hooks/use-api-keys";
import { Key, Shield, Ban, AlertCircle, TrendingUp } from "lucide-react";

export function ApiKeyStats() {
  const {
    data: stats,
    isLoading,
    error,
  } = useApiKeyStats();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-5" />
            <Skeleton className="h-6 w-32" />
          </div>
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="text-center p-4 border rounded-lg">
                <Skeleton className="h-8 w-16 mx-auto mb-2" />
                <Skeleton className="h-4 w-20 mx-auto" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <CardTitle>API Key Statistics</CardTitle>
          </div>
          <CardDescription>
            Overview of your API key usage and status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load API key statistics. {error.message}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          <CardTitle>API Key Statistics</CardTitle>
        </div>
        <CardDescription>
          Overview of your API key usage and status
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Total Keys */}
          <div className="text-center p-4 border rounded-lg bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-950/20 dark:to-blue-900/20 border-blue-200 dark:border-blue-800">
            <div className="flex items-center justify-center mb-2">
              <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
                <Key className="h-6 w-6 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            <div className="text-2xl font-bold text-blue-900 dark:text-blue-100">
              {stats.total}
            </div>
            <div className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Total API Keys
            </div>
          </div>

          {/* Active Keys */}
          <div className="text-center p-4 border rounded-lg bg-gradient-to-br from-green-50 to-green-100 dark:from-green-950/20 dark:to-green-900/20 border-green-200 dark:border-green-800">
            <div className="flex items-center justify-center mb-2">
              <div className="p-2 rounded-full bg-green-100 dark:bg-green-900/30">
                <Shield className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
            </div>
            <div className="text-2xl font-bold text-green-900 dark:text-green-100">
              {stats.active}
            </div>
            <div className="text-sm font-medium text-green-700 dark:text-green-300">
              Active Keys
            </div>
          </div>

          {/* Revoked Keys */}
          <div className="text-center p-4 border rounded-lg bg-gradient-to-br from-orange-50 to-orange-100 dark:from-orange-950/20 dark:to-orange-900/20 border-orange-200 dark:border-orange-800">
            <div className="flex items-center justify-center mb-2">
              <div className="p-2 rounded-full bg-orange-100 dark:bg-orange-900/30">
                <Ban className="h-6 w-6 text-orange-600 dark:text-orange-400" />
              </div>
            </div>
            <div className="text-2xl font-bold text-orange-900 dark:text-orange-100">
              {stats.revoked}
            </div>
            <div className="text-sm font-medium text-orange-700 dark:text-orange-300">
              Revoked Keys
            </div>
          </div>
        </div>

        {/* Additional insights */}
        {stats.total > 0 && (
          <div className="mt-6 pt-6 border-t">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-muted-foreground">
              <div>
                <span className="font-medium">Security Status:</span>{" "}
                {stats.active > 0 
                  ? `${stats.active} active key${stats.active !== 1 ? 's' : ''} in use`
                  : "No active keys"
                }
              </div>
              <div>
                <span className="font-medium">Key Health:</span>{" "}
                {stats.active === stats.total 
                  ? "All keys are active"
                  : stats.revoked > 0
                  ? `${stats.revoked} revoked key${stats.revoked !== 1 ? 's' : ''}`
                  : "Good"
                }
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}