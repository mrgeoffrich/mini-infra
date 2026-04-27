import { useState } from "react";
import { IconPlus, IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateCertificate } from "@/hooks/use-certificates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

const certificateSchema = z.object({
  domains: z
    .array(z.string().min(1, "Domain is required"))
    .min(1, "At least one domain is required"),
  primaryDomain: z.string().min(1, "Primary domain is required"),
  autoRenew: z.boolean(),
  renewalDaysBeforeExpiry: z.number().min(1).max(60),
});

type CertificateFormData = z.infer<typeof certificateSchema>;

interface CreateCertificateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateCertificateDialog({
  open,
  onOpenChange,
}: CreateCertificateDialogProps) {
  const { mutate: createCertificate, isPending } = useCreateCertificate();
  const [domainInput, setDomainInput] = useState("");
  const [domains, setDomains] = useState<string[]>([]);

  const form = useForm<CertificateFormData>({
    resolver: zodResolver(certificateSchema),
    defaultValues: {
      domains: [],
      primaryDomain: "",
      autoRenew: true,
      renewalDaysBeforeExpiry: 30,
    },
  });

  const primaryDomain = useWatch({ control: form.control, name: "primaryDomain" });
  const autoRenew = useWatch({ control: form.control, name: "autoRenew" });
  const renewalDaysBeforeExpiry = useWatch({ control: form.control, name: "renewalDaysBeforeExpiry" });

  const handleAddDomain = () => {
    if (domainInput && !domains.includes(domainInput)) {
      const newDomains = [...domains, domainInput];
      setDomains(newDomains);
      form.setValue("domains", newDomains);

      // Set as primary if first domain
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

    // Update primary if removed
    if (form.getValues("primaryDomain") === domain && newDomains.length > 0) {
      form.setValue("primaryDomain", newDomains[0]);
    }
  };

  const onSubmit = (data: CertificateFormData) => {
    createCertificate(data, {
      onSuccess: () => {
        onOpenChange(false);
        form.reset();
        setDomains([]);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Issue New Certificate</DialogTitle>
          <DialogDescription>
            Request a new SSL/TLS certificate from Let's Encrypt
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                      primaryDomain === domain
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
              checked={autoRenew}
              onCheckedChange={(checked) => form.setValue("autoRenew", checked)}
            />
          </div>

          {/* Renewal days */}
          {autoRenew && (
            <div className="space-y-2">
              <Label>Renew Days Before Expiry</Label>
              <Input
                type="number"
                min={1}
                max={60}
                {...form.register("renewalDaysBeforeExpiry", {
                  valueAsNumber: true,
                })}
              />
              <p className="text-xs text-muted-foreground">
                Certificate will renew automatically{" "}
                {renewalDaysBeforeExpiry} days before expiration
              </p>
            </div>
          )}

          {/* DNS-01 Challenge info */}
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              This will create a DNS-01 challenge via Cloudflare. Ensure your
              Cloudflare API credentials are configured.
            </AlertDescription>
          </Alert>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || domains.length === 0}>
              {isPending ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Issuing...
                </>
              ) : (
                <>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Issue Certificate
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
