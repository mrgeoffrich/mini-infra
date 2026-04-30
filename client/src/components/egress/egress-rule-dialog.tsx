/**
 * EgressRuleDialog — create or edit a single egress rule.
 *
 * Fields:
 *   - pattern  : text input with live FQDN / wildcard validation
 *   - action   : Allow / Block segmented control (ToggleGroup)
 *   - targets  : "Apply to all services" toggle + multi-select checkboxes
 */

import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  IconCheck,
  IconX,
  IconLoader2,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCreateEgressRule, usePatchEgressRule } from "@/hooks/use-egress";
import type { EgressRuleSummary } from "@mini-infra/types";

// ---------------------------------------------------------------------------
// Pattern validation — same regex used server-side
// FQDN: one or more labels, each [a-zA-Z0-9][-a-zA-Z0-9]*, separated by dots
// Wildcard: *. prefix followed by a valid FQDN
// ---------------------------------------------------------------------------

const LABEL_RE = /[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?/;
const FQDN_RE = new RegExp(`^(${LABEL_RE.source})(\\.(${LABEL_RE.source}))*$`);
const WILDCARD_RE = new RegExp(
  `^\\*\\.(${LABEL_RE.source})(\\.(${LABEL_RE.source}))*$`,
);

function isValidPattern(value: string): boolean {
  return FQDN_RE.test(value) || WILDCARD_RE.test(value);
}

const egressRuleSchema = z.object({
  pattern: z
    .string()
    .min(1, "Pattern is required")
    .refine(isValidPattern, {
      message: "Must be a valid FQDN (e.g. api.example.com) or wildcard (e.g. *.example.com)",
    }),
  action: z.enum(["allow", "block"]),
  allServices: z.boolean(),
  targets: z.array(z.string()),
});

type EgressRuleFormData = z.infer<typeof egressRuleSchema>;

/**
 * Pre-fill values for the create flow (e.g. when promoting a blocked traffic
 * event into an allow rule). Ignored when `rule` is also passed (edit wins).
 */
export interface EgressRuleDialogInitialValues {
  pattern?: string;
  action?: "allow" | "block";
  /** When non-empty, defaults "Apply to all services" to false. */
  targets?: string[];
}

interface EgressRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policyId: string;
  serviceNames: string[];
  /** Provide when editing an existing rule. */
  rule?: EgressRuleSummary;
  /** Pre-fill values when CREATING. Ignored if `rule` is provided. */
  initialValues?: EgressRuleDialogInitialValues;
  onSuccess?: () => void;
}

function computeDefaults(
  rule: EgressRuleSummary | undefined,
  initialValues: EgressRuleDialogInitialValues | undefined,
): EgressRuleFormData {
  if (rule) {
    return {
      pattern: rule.pattern,
      action: rule.action,
      allServices: rule.targets.length === 0,
      targets: rule.targets,
    };
  }
  const targets = initialValues?.targets ?? [];
  return {
    pattern: initialValues?.pattern ?? "",
    action: initialValues?.action ?? "allow",
    allServices: targets.length === 0,
    targets,
  };
}

export function EgressRuleDialog({
  open,
  onOpenChange,
  policyId,
  serviceNames,
  rule,
  initialValues,
  onSuccess,
}: EgressRuleDialogProps) {
  const isEdit = !!rule;
  const createMutation = useCreateEgressRule();
  const patchMutation = usePatchEgressRule();
  const isPending = createMutation.isPending || patchMutation.isPending;

  const form = useForm<EgressRuleFormData>({
    resolver: zodResolver(egressRuleSchema),
    defaultValues: computeDefaults(rule, initialValues),
  });

  const allServices = useWatch({ control: form.control, name: "allServices" });
  const patternValue = useWatch({ control: form.control, name: "pattern" });
  const patternValid = patternValue ? isValidPattern(patternValue) : null;

  // Reset form when dialog opens / rule / initialValues change
  useEffect(() => {
    if (open) {
      form.reset(computeDefaults(rule, initialValues));
    }
  }, [open, rule, initialValues, form]);

  const onSubmit = async (data: EgressRuleFormData) => {
    const targets = data.allServices ? [] : data.targets;
    try {
      if (isEdit && rule) {
        await patchMutation.mutateAsync({
          ruleId: rule.id,
          policyId,
          body: { pattern: data.pattern, action: data.action, targets },
        });
        toast.success("Rule updated successfully");
      } else {
        await createMutation.mutateAsync({
          policyId,
          body: { pattern: data.pattern, action: data.action, targets },
        });
        toast.success("Rule created successfully");
      }
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      toast.error(
        `Failed to ${isEdit ? "update" : "create"} rule: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) form.reset();
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Rule" : "Add Rule"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the egress rule pattern, action, or target services."
              : "Define an egress rule to allow or block traffic matching a pattern."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            {/* Pattern */}
            <FormField
              control={form.control}
              name="pattern"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Pattern</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        placeholder="api.example.com or *.example.com"
                        {...field}
                        disabled={isPending}
                        className="font-mono pr-8"
                      />
                      {patternValue && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                          {patternValid ? (
                            <IconCheck className="h-4 w-4 text-green-600" />
                          ) : (
                            <IconX className="h-4 w-4 text-red-500" />
                          )}
                        </span>
                      )}
                    </div>
                  </FormControl>
                  <FormDescription>
                    Enter a fully-qualified domain name (e.g.{" "}
                    <code className="text-xs bg-muted rounded px-1">
                      api.example.com
                    </code>
                    ) or a wildcard prefix (e.g.{" "}
                    <code className="text-xs bg-muted rounded px-1">
                      *.example.com
                    </code>
                    ).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Action */}
            <FormField
              control={form.control}
              name="action"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action</FormLabel>
                  <FormControl>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      value={field.value}
                      onValueChange={(v) => {
                        if (v) field.onChange(v as "allow" | "block");
                      }}
                      disabled={isPending}
                      className="w-full"
                    >
                      <ToggleGroupItem value="allow" className="flex-1">
                        Allow
                      </ToggleGroupItem>
                      <ToggleGroupItem value="block" className="flex-1">
                        Block
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Targets */}
            <div className="space-y-3">
              <FormField
                control={form.control}
                name="allServices"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2 space-y-0">
                    <FormControl>
                      <Checkbox
                        id="all-services"
                        checked={field.value}
                        onCheckedChange={(checked) =>
                          field.onChange(checked === true)
                        }
                        disabled={isPending}
                      />
                    </FormControl>
                    <Label
                      htmlFor="all-services"
                      className="text-sm font-medium cursor-pointer"
                    >
                      Apply to all services
                    </Label>
                  </FormItem>
                )}
              />

              {!allServices && serviceNames.length > 0 && (
                <FormField
                  control={form.control}
                  name="targets"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Target services</FormLabel>
                      <div className="space-y-2 pl-1">
                        {serviceNames.map((name) => {
                          const checked = field.value.includes(name);
                          return (
                            <div
                              key={name}
                              className="flex items-center gap-2"
                            >
                              <Checkbox
                                id={`svc-${name}`}
                                checked={checked}
                                onCheckedChange={(c) => {
                                  const next = c
                                    ? [...field.value, name]
                                    : field.value.filter((t) => t !== name);
                                  field.onChange(next);
                                }}
                                disabled={isPending}
                              />
                              <Label
                                htmlFor={`svc-${name}`}
                                className="font-mono text-xs cursor-pointer"
                              >
                                {name}
                              </Label>
                            </div>
                          );
                        })}
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {!allServices && serviceNames.length === 0 && (
                <Alert>
                  <IconAlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    No services found for this stack. The rule will apply to all
                    services by default.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {/* Hidden submit for keyboard enter */}
            <button type="submit" className="hidden" />
          </form>
        </Form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={form.handleSubmit(onSubmit)}
            disabled={isPending}
          >
            {isPending && (
              <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {isEdit ? "Save Changes" : "Add Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
