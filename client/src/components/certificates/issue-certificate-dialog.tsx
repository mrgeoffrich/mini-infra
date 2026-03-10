/**
 * Issue Certificate progress dialog.
 *
 * Replaces the synchronous CreateCertificateDialog with an async flow
 * that shows real-time progress via Socket.IO.
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { IconPlus, IconAlertCircle, IconCertificate } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { OperationProgressDialog } from "@/components/operation-progress-dialog";
import {
  useStartCertIssuance,
  useCertIssuanceProgress,
} from "@/hooks/use-cert-issuance";

const certificateSchema = z.object({
  domains: z
    .array(z.string().min(1, "Domain is required"))
    .min(1, "At least one domain is required"),
  primaryDomain: z.string().min(1, "Primary domain is required"),
  autoRenew: z.boolean(),
});

type CertificateFormData = z.infer<typeof certificateSchema>;

interface IssueCertificateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function IssueCertificateDialog({
  open,
  onOpenChange,
}: IssueCertificateDialogProps) {
  const [operationId, setOperationId] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");
  const [domains, setDomains] = useState<string[]>([]);

  const startMutation = useStartCertIssuance();
  const progress = useCertIssuanceProgress(operationId);

  const form = useForm<CertificateFormData>({
    resolver: zodResolver(certificateSchema),
    defaultValues: {
      domains: [],
      primaryDomain: "",
      autoRenew: true,
    },
  });

  const handleAddDomain = () => {
    if (domainInput && !domains.includes(domainInput)) {
      const newDomains = [...domains, domainInput];
      setDomains(newDomains);
      form.setValue("domains", newDomains);
      if (newDomains.length === 1) {
        form.setValue("primaryDomain", domainInput);
      }
      setDomainInput("");
    }
  };

  const handleRemoveDomain = (domain: string) => {
    const newDomains = domains.filter((d) => d !== domain);
    setDomains(newDomains);
    form.setValue("domains", newDomains);
    if (form.getValues("primaryDomain") === domain && newDomains.length > 0) {
      form.setValue("primaryDomain", newDomains[0]);
    }
  };

  const handleConfirm = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;

    const data = form.getValues();
    try {
      const result = await startMutation.mutateAsync({
        domains: data.domains,
        primaryDomain: data.primaryDomain,
        autoRenew: data.autoRenew,
      });
      setOperationId(result.data.operationId);
    } catch {
      // Error handled by mutation's onError toast
    }
  };

  const handleClose = () => {
    setOperationId(null);
    progress.reset();
    form.reset();
    setDomains([]);
    setDomainInput("");
  };

  // Build operation state — show step names immediately before socket event arrives
  const certStepNames = [
    "Request certificate from Let's Encrypt",
    "Save certificate record",
    "Store certificate in Azure",
    "Activate certificate",
  ];
  const operationState =
    operationId && progress.state.phase === "idle"
      ? { ...progress.state, phase: "executing" as const, totalSteps: 4, plannedStepNames: certStepNames }
      : progress.state;

  return (
    <OperationProgressDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Issue Certificate"
      titleIcon={<IconCertificate className="h-5 w-5" />}
      operationState={operationState}
      confirmLabel="Issue Certificate"
      confirmDisabled={startMutation.isPending || domains.length === 0}
      onConfirm={handleConfirm}
      onClose={handleClose}
      descriptions={{
        preview: "Request a new SSL/TLS certificate from Let's Encrypt.",
        executing:
          "Issuing certificate... This may take up to a minute for DNS propagation.",
        success: "Certificate issued and stored successfully.",
        error: "Certificate issuance failed.",
      }}
      previewContent={
        <div className="space-y-6">
          {/* Domain input */}
          <div className="space-y-2">
            <Label>Domains</Label>
            <div className="flex gap-2">
              <Input
                placeholder="example.com or *.example.com"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddDomain();
                  }
                }}
              />
              <Button type="button" onClick={handleAddDomain}>
                <IconPlus className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Add one or more domains. Use * for wildcard certificates (e.g.,
              *.example.com)
            </p>
          </div>

          {/* Domain list */}
          {domains.length > 0 && (
            <div className="space-y-2">
              <Label>Added Domains ({domains.length})</Label>
              <div className="flex flex-wrap gap-2">
                {domains.map((domain) => (
                  <Badge
                    key={domain}
                    variant={
                      form.watch("primaryDomain") === domain
                        ? "default"
                        : "secondary"
                    }
                    className="cursor-pointer"
                    onClick={() => form.setValue("primaryDomain", domain)}
                  >
                    {domain}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveDomain(domain);
                      }}
                      className="ml-2"
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Click a domain to set as primary. Primary domain will be the
                certificate's common name.
              </p>
            </div>
          )}

          {/* Auto-renewal toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-Renewal</Label>
              <p className="text-xs text-muted-foreground">
                Automatically renew this certificate before expiry
              </p>
            </div>
            <Switch
              checked={form.watch("autoRenew")}
              onCheckedChange={(checked) => form.setValue("autoRenew", checked)}
            />
          </div>

          {/* DNS-01 Challenge info */}
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              This will create a DNS-01 challenge via Cloudflare. Ensure your
              Cloudflare API credentials are configured.
            </AlertDescription>
          </Alert>
        </div>
      }
    />
  );
}
