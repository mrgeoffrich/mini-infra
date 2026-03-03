import { useParams, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useFileContent, useFetchFileContents } from "@/hooks/use-volumes";
import {
  IconArrowLeft,
  IconRefresh,
  IconAlertCircle,
  IconFile,
  IconCopy,
  IconLoader2,
} from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

// Helper function to format bytes to human-readable size
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function VolumeFileContentPage() {
  const { name, "*": filePath } = useParams<{ name: string; "*": string }>();
  const navigate = useNavigate();

  const volumeName = decodeURIComponent(name || "");
  const decodedFilePath = filePath ? decodeURIComponent(filePath) : null;

  const { data: fileContent, isLoading, error } = useFileContent({
    volumeName,
    filePath: decodedFilePath,
    enabled: !!volumeName && !!decodedFilePath,
  });

  const fetchFileContents = useFetchFileContents(volumeName);

  const handleRefetch = () => {
    if (!decodedFilePath) return;
    fetchFileContents.mutate([decodedFilePath]);
  };

  const handleCopyToClipboard = async () => {
    if (!fileContent?.content) return;

    try {
      await navigator.clipboard.writeText(fileContent.content);
      toast.success("Content copied to clipboard");
    } catch (err) {
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleBackToInspection = () => {
    navigate(`/containers/volumes/${encodeURIComponent(volumeName)}/inspect`);
  };

  if (!volumeName || !decodedFilePath) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <IconAlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <p className="text-destructive font-semibold mb-2">
            Volume name and file path are required
          </p>
          <Button onClick={() => navigate("/containers")}>
            Back to Containers
          </Button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBackToInspection}
            className="mb-2"
          >
            <IconArrowLeft className="mr-2 h-4 w-4" />
            Back to Inspection
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">File Content</h1>
          <p className="text-muted-foreground">
            <code className="text-sm bg-muted px-2 py-1 rounded">{decodedFilePath}</code>
          </p>
        </div>

        <Card className="border-destructive">
          <CardHeader>
            <div className="flex items-center gap-2">
              <IconAlertCircle className="h-6 w-6 text-destructive" />
              <CardTitle className="text-destructive">Content Not Found</CardTitle>
            </div>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              This file's content has not been fetched yet. Go back to the inspection page and select this file to fetch its contents.
            </p>
            <div className="flex gap-2">
              <Button onClick={handleBackToInspection} variant="outline">
                <IconArrowLeft className="mr-2 h-4 w-4" />
                Back to Inspection
              </Button>
              <Button onClick={handleRefetch} disabled={fetchFileContents.isPending}>
                {fetchFileContents.isPending ? (
                  <>
                    <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                    Fetching...
                  </>
                ) : (
                  <>
                    <IconRefresh className="mr-2 h-4 w-4" />
                    Fetch Now
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBackToInspection}
            className="mb-2"
          >
            <IconArrowLeft className="mr-2 h-4 w-4" />
            Back to Inspection
          </Button>
          <Skeleton className="h-10 w-64 mb-2" />
          <Skeleton className="h-6 w-96" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-96 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!fileContent) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <IconAlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="font-semibold mb-2">File content not found</p>
          <Button onClick={handleBackToInspection}>
            Back to Inspection
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBackToInspection}
            className="mb-2"
          >
            <IconArrowLeft className="mr-2 h-4 w-4" />
            Back to Inspection
          </Button>
          <h1 className="text-3xl font-bold tracking-tight">File Content</h1>
          <p className="text-muted-foreground">
            <code className="text-sm bg-muted px-2 py-1 rounded">{decodedFilePath}</code>
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleCopyToClipboard}
            variant="outline"
            size="sm"
          >
            <IconCopy className="mr-2 h-4 w-4" />
            Copy
          </Button>
          <Button
            onClick={handleRefetch}
            variant="outline"
            size="sm"
            disabled={fetchFileContents.isPending}
          >
            {fetchFileContents.isPending ? (
              <>
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                Fetching...
              </>
            ) : (
              <>
                <IconRefresh className="mr-2 h-4 w-4" />
                Re-fetch
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Metadata Card */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">File Size</CardTitle>
            <IconFile className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatBytes(fileContent.size)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Fetched</CardTitle>
            <IconLoader2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold">
              {formatDistanceToNow(new Date(fileContent.fetchedAt), {
                addSuffix: true,
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Volume</CardTitle>
            <IconFile className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-sm font-mono truncate" title={volumeName}>
              {volumeName}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Content Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>File Content</CardTitle>
              <CardDescription>
                Content was cached on {new Date(fileContent.fetchedAt).toLocaleString()}
              </CardDescription>
            </div>
            {fileContent.size > 1024 * 1024 && (
              <Badge variant="secondary">Truncated</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/40 p-4 max-h-[600px] overflow-auto">
            <pre className="text-xs font-mono whitespace-pre-wrap break-words">
              {fileContent.content}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
