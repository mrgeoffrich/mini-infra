import { Link } from "react-router-dom";
import { IconKey, IconPlus, IconAlertCircle, IconShieldCheck } from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiKeysList } from "@/components/api-keys/api-keys-list";
import { ApiKeyStats } from "@/components/api-keys/api-key-stats";
import { useApiKeys } from "@/hooks/use-api-keys";

export function ApiKeysPage() {
  const {
    data: apiKeys,
    isLoading,
    error,
  } = useApiKeys();

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Skeleton className="h-12 w-12" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
            <Skeleton className="h-10 w-32" />
          </div>
        </div>

        <div className="px-4 lg:px-6 max-w-6xl">
          <div className="grid gap-6">
            {/* Stats skeleton */}
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-72" />
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

            {/* Table skeleton */}
            <Card>
              <CardHeader>
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-48" />
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-4 border rounded-lg">
                      <div className="space-y-2 flex-1">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-48" />
                      </div>
                      <div className="flex gap-2">
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-md bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300">
                <IconKey className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">API Keys</h1>
                <p className="text-muted-foreground">
                  Manage your API keys for programmatic access
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 lg:px-6 max-w-6xl">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load API keys. {error.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconKey className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">API Keys</h1>
              <p className="text-muted-foreground">
                Manage your API keys for programmatic access to Mini Infra
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild variant="outline" className="flex items-center gap-2">
              <Link to="/api-keys/presets">
                <IconShieldCheck className="h-4 w-4" />
                Manage Presets
              </Link>
            </Button>
            <Button asChild className="flex items-center gap-2">
              <Link to="/api-keys/new">
                <IconPlus className="h-4 w-4" />
                Create API Key
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {/* Statistics */}
          <ApiKeyStats />

          {/* API Keys List */}
          <Card>
            <CardHeader>
              <CardTitle>Your API Keys</CardTitle>
              <CardDescription>
                {apiKeys?.length === 0 
                  ? "You don't have any API keys yet. Create one to get started." 
                  : `You have ${apiKeys?.length || 0} API key${(apiKeys?.length || 0) !== 1 ? 's' : ''}.`
                }
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ApiKeysList apiKeys={apiKeys || []} />
            </CardContent>
          </Card>
        </div>
      </div>

    </div>
  );
}

export default ApiKeysPage;