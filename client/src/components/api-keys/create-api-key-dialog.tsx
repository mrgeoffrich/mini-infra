import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { useCreateApiKey } from "@/hooks/use-api-keys";
import { toast } from "sonner";
import {
  IconLoader2,
  IconKey,
  IconCopy,
  IconCircleCheck,
  IconAlertTriangle,
  IconEye,
  IconEyeOff
} from "@tabler/icons-react";

// Form validation schema
const CreateApiKeySchema = z.object({
  name: z
    .string()
    .min(1, "API key name is required")
    .max(100, "API key name must be less than 100 characters")
    .regex(
      /^[a-zA-Z0-9\s\-_]+$/,
      "API key name can only contain letters, numbers, spaces, hyphens, and underscores",
    ),
});

type CreateApiKeyFormData = z.infer<typeof CreateApiKeySchema>;

interface CreateApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateApiKeyDialog({ open, onOpenChange }: CreateApiKeyDialogProps) {
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(true);
  const [copied, setCopied] = useState(false);

  const createApiKeyMutation = useCreateApiKey();

  const form = useForm<CreateApiKeyFormData>({
    resolver: zodResolver(CreateApiKeySchema),
    defaultValues: {
      name: "",
    },
  });

  const handleSubmit = async (data: CreateApiKeyFormData) => {
    try {
      const result = await createApiKeyMutation.mutateAsync(data);
      setCreatedKey(result.key);
      toast.success("API key created successfully!");
    } catch (error: unknown) {
      console.error("Failed to create API key:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to create API key";
      toast.error(errorMessage);
    }
  };

  const handleCopy = async () => {
    if (!createdKey) return;
    
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
      toast.success("API key copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
      toast.error("Failed to copy to clipboard");
    }
  };

  const handleClose = () => {
    setCreatedKey(null);
    setShowKey(true);
    setCopied(false);
    form.reset();
    onOpenChange(false);
  };

  const displayKey = createdKey ? (showKey ? createdKey : "mk_" + "•".repeat(64)) : "";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconKey className="h-5 w-5 text-primary" />
            {createdKey ? "API Key Created" : "Create New API Key"}
          </DialogTitle>
          <DialogDescription>
            {createdKey 
              ? "Your new API key has been created. Make sure to copy it now - you won't be able to see it again."
              : "Create a new API key for programmatic access to Mini Infra."
            }
          </DialogDescription>
        </DialogHeader>

        {!createdKey ? (
          // Create form
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="e.g., Production CLI Access" 
                        {...field} 
                      />
                    </FormControl>
                    <FormDescription>
                      A descriptive name to help you identify this API key
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClose}
                  disabled={createApiKeyMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createApiKeyMutation.isPending}
                  className="flex items-center gap-2"
                >
                  {createApiKeyMutation.isPending ? (
                    <>
                      <IconLoader2 className="h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    <>
                      <IconKey className="h-4 w-4" />
                      Create API Key
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        ) : (
          // Success screen
          <div className="space-y-6">
            {/* Success message */}
            <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
              <IconCircleCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                Your API key has been created successfully!
              </AlertDescription>
            </Alert>

            {/* API Key display */}
            <div className="space-y-3">
              <Label htmlFor="api-key">Your API Key</Label>
              <div className="flex items-center gap-2">
                <div className="flex-1 relative">
                  <Input
                    id="api-key"
                    value={displayKey}
                    readOnly
                    className="font-mono text-sm pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? (
                      <IconEyeOff className="h-3 w-3" />
                    ) : (
                      <IconEye className="h-3 w-3" />
                    )}
                  </Button>
                </div>
                <Button
                  onClick={handleCopy}
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2"
                >
                  {copied ? (
                    <>
                      <IconCircleCheck className="h-4 w-4 text-green-600" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <IconCopy className="h-4 w-4" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* Security warning */}
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Important:</strong> This is the only time you'll be able to see this API key. 
                Make sure to copy it and store it securely. You'll need to regenerate a new key if you lose this one.
              </AlertDescription>
            </Alert>

            {/* Usage information */}
            <div className="space-y-3 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Usage Instructions:</p>
              <div className="space-y-2">
                <p>Add one of these headers to your HTTP requests:</p>
                <div className="bg-muted p-3 rounded-md font-mono text-xs space-y-1">
                  <div>Authorization: Bearer {createdKey ? `mk_${"x".repeat(64)}` : ""}</div>
                  <div>x-api-key: {createdKey ? `mk_${"x".repeat(64)}` : ""}</div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end">
              <Button onClick={handleClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}