import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { useCreateApiKey } from "@/hooks/use-api-keys";
import { usePermissionPresets } from "@/hooks/use-permission-presets";
import { toast } from "sonner";
import {
  IconLoader2,
  IconKey,
  IconCopy,
  IconCircleCheck,
  IconAlertTriangle,
  IconEye,
  IconEyeOff,
  IconArrowLeft,
} from "@tabler/icons-react";
import { PERMISSION_GROUPS } from "@mini-infra/types";
import type { PermissionScope } from "@mini-infra/types";

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

export function CreateApiKeyPage() {
  const navigate = useNavigate();
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(true);
  const [copied, setCopied] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [selectedPermissions, setSelectedPermissions] = useState<
    Set<PermissionScope>
  >(new Set());

  const createApiKeyMutation = useCreateApiKey();
  const { data: dbPresets, isLoading: presetsLoading } = usePermissionPresets();

  const form = useForm<CreateApiKeyFormData>({
    resolver: zodResolver(CreateApiKeySchema),
    defaultValues: {
      name: "",
    },
  });

  // Set default preset once DB presets load
  useEffect(() => {
    if (dbPresets && dbPresets.length > 0 && !selectedPreset) {
      const fullAccess = dbPresets.find((p) => p.permissions.includes("*"));
      setSelectedPreset(fullAccess?.id ?? dbPresets[0].id);
    }
  }, [dbPresets, selectedPreset]);

  // Apply selected preset's permissions
  useEffect(() => {
    if (selectedPreset === "custom" || !dbPresets) return;
    const preset = dbPresets.find((p) => p.id === selectedPreset);
    if (preset) {
      setSelectedPermissions(new Set(preset.permissions));
    }
  }, [selectedPreset, dbPresets]);

  const handleSubmit = async (data: CreateApiKeyFormData) => {
    try {
      let permissions: PermissionScope[] | null = null;
      if (selectedPermissions.has("*")) {
        // Wildcard = full access, send null for backwards compatibility
        permissions = null;
      } else {
        permissions = Array.from(selectedPermissions);
      }

      const result = await createApiKeyMutation.mutateAsync({
        name: data.name,
        permissions,
      });
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

  const togglePermission = (scope: PermissionScope) => {
    setSelectedPreset("custom");
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  const toggleDomainAll = (domain: string) => {
    const group = PERMISSION_GROUPS.find((g) => g.domain === domain);
    if (!group) return;

    setSelectedPreset("custom");
    const domainScopes = group.permissions.map((p) => p.scope);
    const allSelected = domainScopes.every((s) =>
      selectedPermissions.has(s),
    );

    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        domainScopes.forEach((s) => next.delete(s));
      } else {
        domainScopes.forEach((s) => next.add(s));
      }
      return next;
    });
  };

  const displayKey = createdKey
    ? showKey
      ? createdKey
      : "mk_" + "\u2022".repeat(64)
    : "";

  const isCustom = selectedPreset === "custom";
  const isFullAccess = selectedPermissions.has("*");
  const permissionCount = isFullAccess ? "All" : selectedPermissions.size.toString();

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconKey className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">
              {createdKey ? "API Key Created" : "Create API Key"}
            </h1>
            <p className="text-muted-foreground">
              {createdKey
                ? "Your new API key has been created. Copy it now — you won't be able to see it again."
                : "Create a new API key for programmatic access to Mini Infra."}
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-3xl">
        {!createdKey ? (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit)}
              className="space-y-6"
            >
              {/* Name field */}
              <Card>
                <CardHeader>
                  <CardTitle>Key Details</CardTitle>
                  <CardDescription>
                    Give your API key a descriptive name to identify it later.
                  </CardDescription>
                </CardHeader>
                <CardContent>
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
                </CardContent>
              </Card>

              {/* Permissions */}
              <Card>
                <CardHeader>
                  <CardTitle>Permissions</CardTitle>
                  <CardDescription>
                    Choose a preset or customize individual permissions for this
                    API key.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Preset selector */}
                  <div className="space-y-3">
                    <Label>Preset</Label>
                    {presetsLoading ? (
                      <Skeleton className="h-10 w-full" />
                    ) : (
                      <Select
                        value={selectedPreset}
                        onValueChange={setSelectedPreset}
                        disabled={presetsLoading}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a permission preset" />
                        </SelectTrigger>
                        <SelectContent>
                          {dbPresets?.map((preset) => (
                            <SelectItem key={preset.id} value={preset.id}>
                              <span>{preset.name}</span>
                            </SelectItem>
                          ))}
                          <SelectItem value="custom">
                            <span>Custom</span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                    {!isCustom && !selectedPermissions.has("*") && (
                      <p className="text-sm text-muted-foreground">
                        {dbPresets?.find((p) => p.id === selectedPreset)?.description}
                      </p>
                    )}
                    {isCustom && (
                      <p className="text-sm text-muted-foreground">
                        {permissionCount} permission
                        {selectedPermissions.size !== 1 ? "s" : ""} selected
                      </p>
                    )}
                  </div>

                  {/* Permission checkboxes */}
                  <Accordion
                    type="multiple"
                    defaultValue={
                      isCustom
                        ? PERMISSION_GROUPS.map((g) => g.domain)
                        : []
                    }
                    className="w-full"
                  >
                    {PERMISSION_GROUPS.map((group) => {
                      const domainScopes = group.permissions.map(
                        (p) => p.scope,
                      );
                      const allSelected =
                        !selectedPermissions.has("*") &&
                        domainScopes.every((s) =>
                          selectedPermissions.has(s),
                        );
                      const someSelected =
                        selectedPermissions.has("*") ||
                        domainScopes.some((s) =>
                          selectedPermissions.has(s),
                        );

                      return (
                        <AccordionItem
                          key={group.domain}
                          value={group.domain}
                        >
                          <AccordionTrigger className="hover:no-underline">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">
                                {group.label}
                              </span>
                              {someSelected && (
                                <Badge
                                  variant={
                                    allSelected ||
                                    selectedPermissions.has("*")
                                      ? "default"
                                      : "secondary"
                                  }
                                  className="text-xs"
                                >
                                  {selectedPermissions.has("*")
                                    ? "All"
                                    : allSelected
                                      ? "All"
                                      : `${domainScopes.filter((s) => selectedPermissions.has(s)).length}/${domainScopes.length}`}
                                </Badge>
                              )}
                            </div>
                          </AccordionTrigger>
                          <AccordionContent>
                            <div className="space-y-3 pt-1">
                              <p className="text-sm text-muted-foreground">
                                {group.description}
                              </p>
                              {/* Select all for domain */}
                              <div className="flex items-center space-x-2 pb-1">
                                <Checkbox
                                  id={`${group.domain}-all`}
                                  checked={
                                    selectedPermissions.has("*") ||
                                    allSelected
                                  }
                                  disabled={
                                    selectedPermissions.has("*")
                                  }
                                  onCheckedChange={() =>
                                    toggleDomainAll(group.domain)
                                  }
                                />
                                <label
                                  htmlFor={`${group.domain}-all`}
                                  className="text-sm font-medium cursor-pointer"
                                >
                                  Select all
                                </label>
                              </div>
                              {/* Individual permissions */}
                              {group.permissions.map((perm) => (
                                <div
                                  key={perm.scope}
                                  className="flex items-start space-x-2 ml-4"
                                >
                                  <Checkbox
                                    id={perm.scope}
                                    checked={
                                      selectedPermissions.has("*") ||
                                      selectedPermissions.has(
                                        perm.scope,
                                      )
                                    }
                                    disabled={
                                      selectedPermissions.has("*")
                                    }
                                    onCheckedChange={() =>
                                      togglePermission(perm.scope)
                                    }
                                  />
                                  <div className="grid gap-0.5 leading-none">
                                    <label
                                      htmlFor={perm.scope}
                                      className="text-sm font-medium cursor-pointer"
                                    >
                                      {perm.label}
                                    </label>
                                    <p className="text-xs text-muted-foreground">
                                      {perm.description}
                                    </p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                </CardContent>
              </Card>

              {/* Actions */}
              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate("/api-keys")}
                  disabled={createApiKeyMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    createApiKeyMutation.isPending ||
                    presetsLoading ||
                    (!isFullAccess && selectedPermissions.size === 0)
                  }
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
          // Success state
          <div className="space-y-6">
            <Alert className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
              <IconCircleCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
              <AlertDescription className="text-green-800 dark:text-green-200">
                Your API key has been created successfully!
              </AlertDescription>
            </Alert>

            {/* API Key display */}
            <Card>
              <CardHeader>
                <CardTitle>Your API Key</CardTitle>
                <CardDescription>
                  Copy this key and store it securely. You won't be able to see
                  it again.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
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
              </CardContent>
            </Card>

            {/* Security warning */}
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Important:</strong> This is the only time you'll be able
                to see this API key. Make sure to copy it and store it securely.
                You'll need to regenerate a new key if you lose this one.
              </AlertDescription>
            </Alert>

            {/* Usage information */}
            <Card>
              <CardHeader>
                <CardTitle>Usage Instructions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>Add one of these headers to your HTTP requests:</p>
                <div className="bg-muted p-3 rounded-md font-mono text-xs space-y-1">
                  <div>
                    Authorization: Bearer {`mk_${"x".repeat(64)}`}
                  </div>
                  <div>
                    x-api-key: {`mk_${"x".repeat(64)}`}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Back button */}
            <div className="flex justify-start">
              <Button
                variant="outline"
                onClick={() => navigate("/api-keys")}
                className="flex items-center gap-2"
              >
                <IconArrowLeft className="h-4 w-4" />
                Back to API Keys
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CreateApiKeyPage;
