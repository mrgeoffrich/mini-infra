import { useState } from "react";
import { format } from "date-fns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  MoreHorizontal, 
  Copy, 
  RotateCcw, 
  Ban, 
  Trash2, 
  CheckCircle,
  AlertTriangle,
  Eye,
  EyeOff,
  Key
} from "lucide-react";
import { ApiKey } from "@/lib/auth-types";
import { useRevokeApiKey, useRotateApiKey, useDeleteApiKey } from "@/hooks/use-api-keys";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { toast } from "sonner";

interface ApiKeysListProps {
  apiKeys: ApiKey[];
}

export function ApiKeysList({ apiKeys }: ApiKeysListProps) {
  const [revokeKeyId, setRevokeKeyId] = useState<string | null>(null);
  const [deleteKeyId, setDeleteKeyId] = useState<string | null>(null);
  const [rotateKeyId, setRotateKeyId] = useState<string | null>(null);
  const [rotatedKey, setRotatedKey] = useState<string | null>(null);
  const [showRotatedKey, setShowRotatedKey] = useState(true);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const { formatDateTime } = useFormattedDate();
  const revokeApiKeyMutation = useRevokeApiKey();
  const rotateApiKeyMutation = useRotateApiKey();
  const deleteApiKeyMutation = useDeleteApiKey();

  const handleCopyKeyPrefix = async (keyId: string) => {
    const keyPrefix = `mk_${keyId.substring(0, 8)}...`;
    try {
      await navigator.clipboard.writeText(keyPrefix);
      setCopiedKeyId(keyId);
      toast.success("Key prefix copied to clipboard!");
      setTimeout(() => setCopiedKeyId(null), 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleCopyRotatedKey = async () => {
    if (!rotatedKey) return;
    
    try {
      await navigator.clipboard.writeText(rotatedKey);
      toast.success("New API key copied to clipboard!");
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleRevoke = async (keyId: string) => {
    try {
      await revokeApiKeyMutation.mutateAsync(keyId);
      toast.success("API key revoked successfully");
      setRevokeKeyId(null);
    } catch (error: unknown) {
      console.error("Failed to revoke API key:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to revoke API key";
      toast.error(errorMessage);
    }
  };

  const handleRotate = async (keyId: string) => {
    try {
      const result = await rotateApiKeyMutation.mutateAsync(keyId);
      setRotatedKey(result.key);
      setRotateKeyId(null);
      toast.success("API key rotated successfully");
    } catch (error: unknown) {
      console.error("Failed to rotate API key:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to rotate API key";
      toast.error(errorMessage);
    }
  };

  const handleDelete = async (keyId: string) => {
    try {
      await deleteApiKeyMutation.mutateAsync(keyId);
      toast.success("API key deleted permanently");
      setDeleteKeyId(null);
    } catch (error: unknown) {
      console.error("Failed to delete API key:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to delete API key";
      toast.error(errorMessage);
    }
  };

  const closeRotatedKeyDialog = () => {
    setRotatedKey(null);
    setShowRotatedKey(true);
  };

  if (apiKeys.length === 0) {
    return (
      <div className="text-center py-12">
        <Key className="mx-auto h-12 w-12 text-muted-foreground/50" />
        <h3 className="mt-4 text-lg font-medium">No API keys</h3>
        <p className="mt-2 text-muted-foreground">
          You haven't created any API keys yet. Create one to get started with programmatic access.
        </p>
      </div>
    );
  }

  const revokeKey = apiKeys.find(key => key.id === revokeKeyId);
  const deleteKey = apiKeys.find(key => key.id === deleteKeyId);

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[70px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apiKeys.map((apiKey) => (
              <TableRow key={apiKey.id}>
                <TableCell className="font-medium">
                  {apiKey.name}
                </TableCell>
                <TableCell>
                  <Badge variant={apiKey.active ? "default" : "secondary"}>
                    {apiKey.active ? "Active" : "Revoked"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono text-muted-foreground">
                      mk_{apiKey.id.substring(0, 8)}...
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCopyKeyPrefix(apiKey.id)}
                      className="h-6 w-6 p-0"
                    >
                      {copiedKeyId === apiKey.id ? (
                        <CheckCircle className="h-3 w-3 text-green-600" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {apiKey.lastUsedAt 
                    ? formatDateTime(new Date(apiKey.lastUsedAt))
                    : "Never"
                  }
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(new Date(apiKey.createdAt))}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="h-8 w-8 p-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {apiKey.active && (
                        <>
                          <DropdownMenuItem onClick={() => setRotateKeyId(apiKey.id)}>
                            <RotateCcw className="mr-2 h-4 w-4" />
                            Rotate
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setRevokeKeyId(apiKey.id)}>
                            <Ban className="mr-2 h-4 w-4" />
                            Revoke
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <DropdownMenuItem 
                        onClick={() => setDeleteKeyId(apiKey.id)}
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Permanently
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Revoke confirmation dialog */}
      <AlertDialog open={!!revokeKeyId} onOpenChange={() => setRevokeKeyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to revoke the API key "{revokeKey?.name}"? 
              This action will immediately disable the key, but you can rotate it later to create a new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeKeyId && handleRevoke(revokeKeyId)}
              disabled={revokeApiKeyMutation.isPending}
            >
              {revokeApiKeyMutation.isPending ? "Revoking..." : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteKeyId} onOpenChange={() => setDeleteKeyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete API Key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete the API key "{deleteKey?.name}"? 
              This action cannot be undone and the key will be completely removed from the system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteKeyId && handleDelete(deleteKeyId)}
              disabled={deleteApiKeyMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteApiKeyMutation.isPending ? "Deleting..." : "Delete Permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rotate confirmation dialog */}
      <AlertDialog open={!!rotateKeyId} onOpenChange={() => setRotateKeyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate API Key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to rotate this API key? This will generate a new key and immediately 
              deactivate the current one. You'll need to update any applications using the old key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => rotateKeyId && handleRotate(rotateKeyId)}
              disabled={rotateApiKeyMutation.isPending}
            >
              {rotateApiKeyMutation.isPending ? "Rotating..." : "Rotate Key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rotated key display dialog */}
      <Dialog open={!!rotatedKey} onOpenChange={closeRotatedKeyDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-5 w-5 text-primary" />
              API Key Rotated
            </DialogTitle>
            <DialogDescription>
              Your API key has been rotated successfully. The old key has been deactivated and this new key is now active.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Success message */}
            <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
              <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                API key rotated successfully! The old key is now inactive.
              </AlertDescription>
            </Alert>

            {/* New API Key display */}
            <div className="space-y-3">
              <Label htmlFor="new-api-key">New API Key</Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <Input
                    id="new-api-key"
                    value={rotatedKey ? (showRotatedKey ? rotatedKey : "mk_" + "•".repeat(64)) : ""}
                    readOnly
                    className="font-mono text-sm pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowRotatedKey(!showRotatedKey)}
                  >
                    {showRotatedKey ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <Button
                  onClick={handleCopyRotatedKey}
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2"
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
              </div>
            </div>

            {/* Security warning */}
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Important:</strong> Make sure to update any applications or scripts using the old API key 
                with this new key. The old key is now inactive and will no longer work.
              </AlertDescription>
            </Alert>

            {/* Actions */}
            <div className="flex justify-end">
              <Button onClick={closeRotatedKeyDialog}>
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}