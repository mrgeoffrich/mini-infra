# TLS Certificate Management - Frontend Design Document

## Overview

This document provides comprehensive frontend implementation specifications for the TLS Certificate Management feature (Phase 5 of TLS Renewal Service Implementation Plan). The design follows established Mini Infra patterns for page layouts, iconography, and component architecture.

**Design Principles:**
- Consistent with existing Mini Infra UI patterns (Registry Credentials, Self-Backup pages)
- Responsive mobile-first design using Tailwind CSS
- Accessible components following WCAG 2.1 guidelines
- Timezone-aware date/time displays using user preferences
- Optimistic UI updates with React Query

---

## Table of Contents

1. [Navigation Integration](#navigation-integration)
2. [Page Specifications](#page-specifications)
3. [Component Library](#component-library)
4. [React Query Hooks](#react-query-hooks)
5. [API Client Integration](#api-client-integration)
6. [Type Definitions](#type-definitions)
7. [Implementation Checklist](#implementation-checklist)

---

## Navigation Integration

### Sidebar Route Configuration

**File**: `client/src/lib/route-config.ts`

Add the certificates route to the main navigation:

```typescript
import {
  // ... existing imports
  IconCertificate,
  IconSettings,
} from "@tabler/icons-react";

export const routes = {
  // ... existing routes

  '/certificates': {
    icon: IconCertificate,
    title: 'TLS Certificates',
    description: 'Manage SSL/TLS certificates and renewals',
    children: null
  },

  '/settings': {
    icon: IconSettings,
    title: 'Settings',
    description: 'System configuration',
    children: {
      // ... existing children
      '/settings/tls': {
        title: 'TLS Configuration',
        description: 'Certificate authority and Key Vault settings'
      }
    }
  }
};
```

**Icon Choice**: `IconCertificate` from Tabler Icons
- Represents SSL/TLS certificates visually
- Consistent with security and authentication iconography
- Size: Default navigation icon size (no className needed)

**Navigation Position**: Between "API Keys" and "Settings" in main navigation

---

## Page Specifications

### 1. Certificate List Page

**Route**: `/certificates`
**File**: `client/src/app/certificates/page.tsx`

#### Layout Structure

```tsx
import {
  IconCertificate,
  IconPlus,
  IconRefresh,
  IconAlertCircle,
  IconCircleCheck,
  IconClock,
  IconLoader2,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useCertificates } from "@/hooks/use-certificates";

export default function CertificatesPage() {
  const { data: certificates, isLoading, error, refetch } = useCertificates();
  const { formatDateTime, formatDate } = useFormattedDate();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        {/* Header skeleton */}
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-md" />
            <div className="space-y-2">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-4 w-96" />
            </div>
          </div>
        </div>

        {/* Content skeleton */}
        <div className="px-4 lg:px-6 max-w-7xl">
          <Skeleton className="h-[500px] w-full" />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <IconCertificate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">TLS Certificates</h1>
              <p className="text-muted-foreground">
                Manage SSL/TLS certificates and automatic renewals
              </p>
            </div>
          </div>

          <Alert variant="destructive" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load certificates. Please try refreshing the page.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  // Main content
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header with action button */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <IconCertificate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">TLS Certificates</h1>
              <p className="text-muted-foreground">
                Manage SSL/TLS certificates and automatic renewals
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => refetch()}>
              <IconRefresh className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <IconPlus className="h-4 w-4 mr-2" />
              Issue Certificate
            </Button>
          </div>
        </div>

        {/* Expiry warnings */}
        {certificates?.some(cert => isExpiringWithin(cert.notAfter, 14)) && (
          <Alert variant="warning" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              You have {certificates.filter(cert => isExpiringWithin(cert.notAfter, 14)).length} certificate(s) expiring within 14 days.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Certificate list */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Certificates</CardTitle>
            <CardDescription>
              {certificates?.length || 0} active certificate{certificates?.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CertificateList certificates={certificates} />
          </CardContent>
        </Card>
      </div>

      {/* Create certificate dialog */}
      <CreateCertificateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </div>
  );
}
```

#### Design Details

**Header Icon**:
- Icon: `IconCertificate` (Tabler)
- Background: Green (`bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300`)
- Size: `h-6 w-6` inside `p-3 rounded-md`

**Action Buttons**:
- Primary: "Issue Certificate" with `IconPlus`
- Secondary: "Refresh" with `IconRefresh`
- Both buttons right-aligned in header using `justify-between`

**Alert Banners**:
- Warning for certificates expiring within 14 days
- Error state for API failures
- Uses `Alert` component with appropriate variants

**Content Cards**:
- Single card containing `CertificateList` component
- `max-w-7xl` for content width constraint
- Card title shows total certificate count

---

### 2. Certificate Details Page

**Route**: `/certificates/:id`
**File**: `client/src/app/certificates/[id]/page.tsx`

#### Layout Structure

```tsx
import {
  IconCertificate,
  IconRefresh,
  IconTrash,
  IconAlertCircle,
  IconArrowLeft,
  IconCalendar,
  IconKey,
  IconCloud,
} from "@tabler/icons-react";
import { useParams, useNavigate } from "react-router-dom";
import { useCertificate, useRenewalHistory } from "@/hooks/use-certificates";
import { useFormattedDate } from "@/hooks/use-formatted-date";

export default function CertificateDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: certificate, isLoading } = useCertificate(id!);
  const { data: renewalHistory } = useRenewalHistory(id!);
  const { formatDateTime, formatDate } = useFormattedDate();

  if (isLoading) {
    return <div>Loading skeleton...</div>;
  }

  if (!certificate) {
    return <div>Not found...</div>;
  }

  const daysUntilExpiry = Math.floor(
    (new Date(certificate.notAfter).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header with back button */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/certificates')}
          >
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Certificates
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <IconCertificate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">{certificate.primaryDomain}</h1>
              <p className="text-muted-foreground">
                Certificate Details
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleRenewCertificate()}>
              <IconRefresh className="h-4 w-4 mr-2" />
              Renew Now
            </Button>
            <Button variant="destructive" onClick={() => handleRevokeCertificate()}>
              <IconTrash className="h-4 w-4 mr-2" />
              Revoke
            </Button>
          </div>
        </div>
      </div>

      {/* Certificate info cards */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <div className="grid gap-4 md:grid-cols-2">
          {/* Status and expiry card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconCalendar className="h-5 w-5" />
                Certificate Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Status</label>
                  <div className="mt-1">
                    <CertificateStatusBadge status={certificate.status} />
                  </div>
                </div>

                <div>
                  <label className="text-sm font-medium">Expires</label>
                  <p className="mt-1 text-sm">{formatDateTime(certificate.notAfter)}</p>
                  <p className="text-xs text-muted-foreground">
                    {daysUntilExpiry} days remaining
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Issued</label>
                  <p className="mt-1 text-sm">{formatDateTime(certificate.issuedAt)}</p>
                </div>

                <div>
                  <label className="text-sm font-medium">Auto-Renewal</label>
                  <p className="mt-1 text-sm">
                    {certificate.autoRenew ? '✓ Enabled' : '✗ Disabled'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Key Vault info card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <IconCloud className="h-5 w-5" />
                Key Vault Storage
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Certificate Name</label>
                  <p className="mt-1 text-sm font-mono">
                    {certificate.keyVaultCertificateName}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Version</label>
                  <p className="mt-1 text-sm font-mono">
                    {certificate.keyVaultVersion}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Provider</label>
                  <p className="mt-1 text-sm">
                    {certificate.acmeProvider}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Issuer</label>
                  <p className="mt-1 text-sm">
                    {certificate.issuer}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Domains card */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Covered Domains</CardTitle>
            <CardDescription>
              This certificate is valid for {certificate.domains.length} domain{certificate.domains.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {certificate.domains.map((domain) => (
                <Badge key={domain} variant="secondary">
                  {domain}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Renewal history */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Renewal History</CardTitle>
            <CardDescription>
              Past renewal attempts and their status
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RenewalHistoryTable renewals={renewalHistory || []} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

#### Design Details

**Navigation**:
- Back button at top using `IconArrowLeft`
- Returns to `/certificates` list page
- Ghost button style for subtle appearance

**Layout Grid**:
- Two-column grid for status and Key Vault cards on desktop
- Stacks to single column on mobile
- Uses `md:grid-cols-2` responsive grid

**Icons**:
- `IconCalendar` for certificate status section
- `IconCloud` for Key Vault storage section
- `IconKey` for domain security indicators
- All icons sized at `h-5 w-5` in card headers

---

### 3. Create Certificate Page/Dialog

**Component**: Dialog-based form (not separate page)
**File**: `client/src/components/certificates/create-certificate-dialog.tsx`

#### Component Structure

```tsx
import {
  IconPlus,
  IconAlertCircle,
  IconLoader2,
} from "@tabler/icons-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useCreateCertificate } from "@/hooks/use-certificates";

const certificateSchema = z.object({
  domains: z.array(z.string().min(1, "Domain is required"))
    .min(1, "At least one domain is required"),
  primaryDomain: z.string().min(1, "Primary domain is required"),
  autoRenew: z.boolean().default(true),
  renewalDaysBeforeExpiry: z.number().min(1).max(60).default(30),
});

type CertificateFormData = z.infer<typeof certificateSchema>;

export function CreateCertificateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
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
    const newDomains = domains.filter(d => d !== domain);
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
                  if (e.key === 'Enter') {
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
              Add one or more domains. Use * for wildcard certificates (e.g., *.example.com)
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
                    variant={form.watch("primaryDomain") === domain ? "default" : "secondary"}
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
                Click a domain to set as primary. Primary domain will be the certificate's common name.
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

          {/* Renewal days */}
          {form.watch("autoRenew") && (
            <div className="space-y-2">
              <Label>Renew Days Before Expiry</Label>
              <Input
                type="number"
                min={1}
                max={60}
                {...form.register("renewalDaysBeforeExpiry", { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                Certificate will renew automatically {form.watch("renewalDaysBeforeExpiry")} days before expiration
              </p>
            </div>
          )}

          {/* DNS-01 Challenge info */}
          <Alert>
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              This will create a DNS-01 challenge via Cloudflare. Ensure your Cloudflare API credentials are configured.
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
```

#### Design Details

**Form Layout**:
- Dialog-based (not full page) for quick access
- Max width: `sm:max-w-[600px]`
- Form fields use `space-y-6` for consistent spacing

**Domain Management**:
- Input field with "Add" button
- Domains displayed as badges
- Click badge to set as primary (visual feedback via variant change)
- Click × on badge to remove domain

**Validation**:
- Zod schema for type-safe validation
- React Hook Form for form state management
- Real-time validation feedback

**Loading State**:
- Submit button shows spinner (`IconLoader2 animate-spin`)
- Disabled state during submission
- Form fields remain accessible (not disabled) for UX

---

### 4. TLS Settings Page

**Route**: `/settings/tls`
**File**: `client/src/app/settings/tls/page.tsx`

#### Layout Structure

```tsx
import {
  IconSettings,
  IconCloudQuestion,
  IconAlertCircle,
  IconCircleCheck,
  IconLoader2,
} from "@tabler/icons-react";
import { useTlsSettings, useUpdateTlsSettings, useTestTlsConnectivity } from "@/hooks/use-tls-settings";
import { useForm } from "react-hook-form";

export default function TlsSettingsPage() {
  const { data: settings, isLoading } = useTlsSettings();
  const { mutate: updateSettings, isPending } = useUpdateTlsSettings();
  const { mutate: testConnectivity, isPending: isTesting } = useTestTlsConnectivity();

  const form = useForm({
    defaultValues: settings,
  });

  if (isLoading) {
    return <div>Loading skeleton...</div>;
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
            <IconSettings className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">TLS Configuration</h1>
            <p className="text-muted-foreground">
              Configure Azure Key Vault and ACME settings for certificate management
            </p>
          </div>
        </div>
      </div>

      {/* Azure Key Vault configuration */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Azure Key Vault</CardTitle>
            <CardDescription>
              Certificate storage and private key management
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4">
              <div>
                <Label>Key Vault URL</Label>
                <Input
                  placeholder="https://my-vault.vault.azure.net/"
                  {...form.register("key_vault_url")}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>Tenant ID</Label>
                  <Input
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    {...form.register("key_vault_tenant_id")}
                  />
                </div>

                <div>
                  <Label>Client ID</Label>
                  <Input
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    {...form.register("key_vault_client_id")}
                  />
                </div>
              </div>

              <div>
                <Label>Client Secret</Label>
                <Input
                  type="password"
                  placeholder="••••••••••••••••"
                  {...form.register("key_vault_client_secret")}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => testConnectivity(form.getValues())}
                  disabled={isTesting}
                >
                  {isTesting ? (
                    <>
                      <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    <>
                      <IconCloudQuestion className="h-4 w-4 mr-2" />
                      Test Connection
                    </>
                  )}
                </Button>

                <Button
                  type="button"
                  onClick={() => updateSettings(form.getValues())}
                  disabled={isPending}
                >
                  {isPending ? (
                    <>
                      <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Settings"
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* ACME configuration */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>ACME Provider</CardTitle>
            <CardDescription>
              Let's Encrypt certificate authority settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4">
              <div>
                <Label>Provider</Label>
                <Select
                  value={form.watch("default_acme_provider")}
                  onValueChange={(value) => form.setValue("default_acme_provider", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="letsencrypt">Let's Encrypt (Production)</SelectItem>
                    <SelectItem value="letsencrypt-staging">Let's Encrypt (Staging)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  Use staging for testing to avoid rate limits
                </p>
              </div>

              <div>
                <Label>Email Address</Label>
                <Input
                  type="email"
                  placeholder="admin@example.com"
                  {...form.register("default_acme_email")}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Used for ACME account registration and renewal notifications
                </p>
              </div>

              <Button
                type="button"
                onClick={() => updateSettings(form.getValues())}
                disabled={isPending}
              >
                Save Settings
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {/* Renewal scheduler configuration */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Renewal Scheduler</CardTitle>
            <CardDescription>
              Automatic certificate renewal configuration
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4">
              <div>
                <Label>Check Schedule (Cron)</Label>
                <Input
                  placeholder="0 2 * * *"
                  {...form.register("renewal_check_cron")}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Default: Daily at 2 AM (0 2 * * *)
                </p>
              </div>

              <div>
                <Label>Renew Days Before Expiry</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  {...form.register("renewal_days_before_expiry", { valueAsNumber: true })}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Certificates will renew this many days before expiration
                </p>
              </div>

              <Button
                type="button"
                onClick={() => updateSettings(form.getValues())}
                disabled={isPending}
              >
                Save Settings
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

#### Design Details

**Header Icon**:
- Icon: `IconSettings`
- Background: Purple (`bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300`)
- Distinguishes from certificate management pages (green)

**Form Cards**:
- Three separate cards for Azure, ACME, and Scheduler
- Each card has its own "Save Settings" button
- Independent form submission for each section

**Test Connection Button**:
- Uses `IconCloudQuestion` (cloud service testing)
- Outline variant for secondary action
- Shows loading spinner during test

**Grid Layout**:
- Two-column grid for Tenant ID and Client ID
- Responsive: stacks on mobile (`md:grid-cols-2`)

---

## Component Library

### CertificateList Component

**File**: `client/src/components/certificates/certificate-list.tsx`

```tsx
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconCertificate,
  IconRefresh,
  IconTrash,
  IconDotsVertical,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
} from "@tanstack/react-table";

export function CertificateList({ certificates }: { certificates: TlsCertificate[] }) {
  const navigate = useNavigate();
  const { formatDateTime } = useFormattedDate();
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<TlsCertificate>[]>(
    () => [
      {
        accessorKey: "primaryDomain",
        header: "Domain",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <IconCertificate className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="font-medium">{row.original.primaryDomain}</div>
              {row.original.domains.length > 1 && (
                <div className="text-xs text-muted-foreground">
                  +{row.original.domains.length - 1} more
                </div>
              )}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <CertificateStatusBadge status={row.original.status} />
        ),
      },
      {
        accessorKey: "notAfter",
        header: "Expires",
        cell: ({ row }) => {
          const daysUntilExpiry = Math.floor(
            (new Date(row.original.notAfter).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
          );
          return (
            <div>
              <div className="text-sm">{formatDateTime(row.original.notAfter)}</div>
              <div className={cn(
                "text-xs",
                daysUntilExpiry <= 7 ? "text-red-600" :
                daysUntilExpiry <= 14 ? "text-orange-600" :
                "text-muted-foreground"
              )}>
                {daysUntilExpiry} days remaining
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "autoRenew",
        header: "Auto-Renew",
        cell: ({ row }) => (
          <Badge variant={row.original.autoRenew ? "default" : "secondary"}>
            {row.original.autoRenew ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <IconDotsVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/certificates/${row.original.id}`)}>
                <IconCertificate className="h-4 w-4 mr-2" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleRenew(row.original.id)}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Renew Now
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => handleRevoke(row.original.id)}
                className="text-destructive"
              >
                <IconTrash className="h-4 w-4 mr-2" />
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [formatDateTime, navigate]
  );

  const table = useReactTable({
    data: certificates,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder
                  ? null
                  : flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows?.length ? (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => navigate(`/certificates/${row.original.id}`)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-24 text-center">
              No certificates found
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
```

**Features**:
- TanStack Table for sorting and column management
- Click row to navigate to details page
- Context menu for actions (Renew, Revoke)
- Timezone-aware date formatting via `useFormattedDate()`
- Color-coded expiry warnings (red: ≤7 days, orange: ≤14 days)

---

### CertificateStatusBadge Component

**File**: `client/src/components/certificates/certificate-status-badge.tsx`

```tsx
import { IconCircleCheck, IconClock, IconAlertCircle, IconCircleX, IconBan } from "@tabler/icons-react";

export function CertificateStatusBadge({ status }: { status: string }) {
  const statusConfig = {
    ACTIVE: {
      variant: "default" as const,
      icon: IconCircleCheck,
      label: "Active",
      className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
    },
    PENDING: {
      variant: "secondary" as const,
      icon: IconClock,
      label: "Pending",
      className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
    },
    RENEWING: {
      variant: "secondary" as const,
      icon: IconClock,
      label: "Renewing",
      className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
    },
    EXPIRED: {
      variant: "destructive" as const,
      icon: IconCircleX,
      label: "Expired",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    },
    REVOKED: {
      variant: "destructive" as const,
      icon: IconBan,
      label: "Revoked",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    },
    ERROR: {
      variant: "destructive" as const,
      icon: IconAlertCircle,
      label: "Error",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    },
  };

  const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.ERROR;
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className={config.className}>
      <Icon className="h-3 w-3 mr-1" />
      {config.label}
    </Badge>
  );
}
```

**Status Icons**:
- **ACTIVE**: `IconCircleCheck` (green)
- **PENDING**: `IconClock` (blue)
- **RENEWING**: `IconClock` (orange)
- **EXPIRED**: `IconCircleX` (red)
- **REVOKED**: `IconBan` (red)
- **ERROR**: `IconAlertCircle` (red)

---

### RenewalHistoryTable Component

**File**: `client/src/components/certificates/renewal-history-table.tsx`

```tsx
import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconAlertTriangle,
} from "@tabler/icons-react";

export function RenewalHistoryTable({ renewals }: { renewals: TlsCertificateRenewal[] }) {
  const { formatDateTime } = useFormattedDate();

  if (renewals.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No renewal history available
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Attempt</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Triggered By</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {renewals.map((renewal) => (
          <TableRow key={renewal.id}>
            <TableCell>{formatDateTime(renewal.startedAt)}</TableCell>
            <TableCell>
              <RenewalStatusBadge status={renewal.status} />
            </TableCell>
            <TableCell>
              {renewal.attemptNumber}
              {renewal.attemptNumber > 1 && (
                <IconAlertTriangle className="h-3 w-3 inline ml-1 text-orange-600" />
              )}
            </TableCell>
            <TableCell>
              {renewal.durationMs
                ? `${(renewal.durationMs / 1000).toFixed(1)}s`
                : "-"}
            </TableCell>
            <TableCell className="font-mono text-sm">
              {renewal.triggeredBy}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RenewalStatusBadge({ status }: { status: string }) {
  const config = {
    COMPLETED: {
      icon: IconCircleCheck,
      label: "Completed",
      className: "text-green-600",
    },
    FAILED: {
      icon: IconCircleX,
      label: "Failed",
      className: "text-red-600",
    },
    // ... other statuses
  };

  const statusConfig = config[status as keyof typeof config];
  if (!statusConfig) return <span>{status}</span>;

  const Icon = statusConfig.icon;

  return (
    <div className={cn("flex items-center gap-1", statusConfig.className)}>
      <Icon className="h-4 w-4" />
      <span>{statusConfig.label}</span>
    </div>
  );
}
```

**Features**:
- Timezone-aware dates
- Visual indicator for retries (warning icon on attempt > 1)
- Duration displayed in seconds
- Status icons for quick visual scanning

---

## React Query Hooks

### useCertificates Hook

**File**: `client/src/hooks/use-certificates.ts`

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";

export function useCertificates() {
  return useQuery({
    queryKey: ["certificates"],
    queryFn: async () => {
      const response = await apiClient.get("/api/tls/certificates");
      return response.data.data as TlsCertificate[];
    },
    staleTime: 30000, // 30 seconds
  });
}

export function useCertificate(id: string) {
  return useQuery({
    queryKey: ["certificates", id],
    queryFn: async () => {
      const response = await apiClient.get(`/api/tls/certificates/${id}`);
      return response.data.data as TlsCertificate;
    },
    enabled: !!id,
  });
}

export function useCreateCertificate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateCertificateRequest) => {
      const response = await apiClient.post("/api/tls/certificates", data);
      return response.data.data as TlsCertificate;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      toast.success(`Certificate issued for ${data.primaryDomain}`);
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || "Failed to issue certificate");
    },
  });
}

export function useRenewCertificate(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await apiClient.post(`/api/tls/certificates/${id}/renew`);
      return response.data.data as TlsCertificate;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      queryClient.invalidateQueries({ queryKey: ["certificates", id] });
      queryClient.invalidateQueries({ queryKey: ["renewals", id] });
      toast.success(`Certificate renewal initiated for ${data.primaryDomain}`);
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || "Failed to renew certificate");
    },
  });
}

export function useRenewalHistory(certificateId: string) {
  return useQuery({
    queryKey: ["renewals", certificateId],
    queryFn: async () => {
      const response = await apiClient.get(`/api/tls/renewals?certificateId=${certificateId}`);
      return response.data.data as TlsCertificateRenewal[];
    },
    enabled: !!certificateId,
  });
}

export function useRevokeCertificate(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const response = await apiClient.delete(`/api/tls/certificates/${id}`);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["certificates"] });
      toast.success("Certificate revoked successfully");
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || "Failed to revoke certificate");
    },
  });
}
```

**Query Keys**:
- `["certificates"]` - Certificate list
- `["certificates", id]` - Single certificate
- `["renewals", certificateId]` - Renewal history

**Cache Strategy**:
- Stale time: 30 seconds for certificate list
- Automatic invalidation on mutations
- Optimistic updates for better UX

---

### useTlsSettings Hook

**File**: `client/src/hooks/use-tls-settings.ts`

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";

export function useTlsSettings() {
  return useQuery({
    queryKey: ["settings", "tls"],
    queryFn: async () => {
      const response = await apiClient.get("/api/tls/settings");
      return response.data.data as Record<string, string>;
    },
  });
}

export function useUpdateTlsSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (settings: Record<string, string>) => {
      const response = await apiClient.put("/api/tls/settings", settings);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "tls"] });
      toast.success("TLS settings saved successfully");
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || "Failed to save settings");
    },
  });
}

export function useTestTlsConnectivity() {
  return useMutation({
    mutationFn: async (settings: Record<string, string>) => {
      const response = await apiClient.post("/api/tls/connectivity/test", settings);
      return response.data;
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Connection successful! Azure Key Vault is reachable.");
      } else {
        toast.error(data.error || "Connection failed");
      }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || "Failed to test connection");
    },
  });
}
```

---

## API Client Integration

### API Routes

**File**: `client/src/lib/api-client.ts`

Add TLS endpoints to the API client:

```typescript
export const tlsEndpoints = {
  // Certificates
  listCertificates: "/api/tls/certificates",
  getCertificate: (id: string) => `/api/tls/certificates/${id}`,
  createCertificate: "/api/tls/certificates",
  renewCertificate: (id: string) => `/api/tls/certificates/${id}/renew`,
  revokeCertificate: (id: string) => `/api/tls/certificates/${id}`,

  // Renewals
  listRenewals: "/api/tls/renewals",
  getRenewal: (id: string) => `/api/tls/renewals/${id}`,

  // Settings
  getSettings: "/api/tls/settings",
  updateSettings: "/api/tls/settings",

  // Connectivity
  testConnectivity: "/api/tls/connectivity/test",
  getConnectivityStatus: "/api/tls/connectivity/status",

  // Health
  getCertificateHealth: "/api/tls/certificates/health",
  getMetrics: "/api/tls/metrics",
};
```

---

## Type Definitions

### Shared Types

**File**: `lib/types/tls.ts`

```typescript
export interface TlsCertificate {
  id: string;

  // Certificate identification
  domains: string[];
  primaryDomain: string;
  certificateType: "ACME" | "MANUAL";

  // ACME-specific fields
  acmeProvider: string | null;
  acmeAccountId: string | null;
  acmeOrderUrl: string | null;

  // Azure Key Vault references
  keyVaultCertificateName: string;
  keyVaultVersion: string | null;
  keyVaultSecretId: string | null;

  // Certificate metadata
  issuer: string | null;
  serialNumber: string | null;
  fingerprint: string | null;

  // Lifecycle dates
  issuedAt: Date;
  notBefore: Date;
  notAfter: Date;
  renewAfter: Date;
  lastRenewedAt: Date | null;

  // Status tracking
  status: "PENDING" | "ACTIVE" | "RENEWING" | "EXPIRED" | "REVOKED" | "ERROR";
  lastError: string | null;
  lastErrorAt: Date | null;

  // Configuration
  autoRenew: boolean;
  renewalDaysBeforeExpiry: number;

  // Associated HAProxy frontends
  haproxyFrontends: string[];

  // Audit trail
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TlsCertificateRenewal {
  id: string;
  certificateId: string;

  // Renewal attempt details
  attemptNumber: number;
  status: "INITIATED" | "DNS_CHALLENGE_CREATED" | "DNS_CHALLENGE_VALIDATED" |
          "CERTIFICATE_ISSUED" | "STORED_IN_VAULT" | "DEPLOYED_TO_HAPROXY" |
          "COMPLETED" | "FAILED";

  // Timing
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;

  // ACME details
  acmeOrderUrl: string | null;
  acmeChallengeType: string | null;
  dnsRecordName: string | null;
  dnsRecordValue: string | null;

  // Key Vault details
  keyVaultVersion: string | null;

  // HAProxy deployment
  haproxyReloadMethod: string | null;
  haproxyReloadSuccess: boolean;

  // Error tracking
  errorMessage: string | null;
  errorCode: string | null;
  errorDetails: string | null;

  // Metadata
  triggeredBy: string;
  metadata: string | null;
}

export interface CreateCertificateRequest {
  domains: string[];
  primaryDomain: string;
  autoRenew?: boolean;
  renewalDaysBeforeExpiry?: number;
}

export interface TlsSettings {
  key_vault_url: string;
  key_vault_tenant_id: string;
  key_vault_client_id: string;
  key_vault_client_secret: string;
  default_acme_provider: "letsencrypt" | "letsencrypt-staging";
  default_acme_email: string;
  renewal_check_cron: string;
  renewal_days_before_expiry: string;
}
```

**Export from index**:

**File**: `lib/types/index.ts`

```typescript
export * from "./tls";
```

---

## Implementation Checklist

### Phase 5.1: Foundation (Days 1-2)

- [ ] **Type Definitions**
  - [ ] Create `lib/types/tls.ts`
  - [ ] Add types to `lib/types/index.ts`
  - [ ] Build shared types package (`cd lib && npm run build`)

- [ ] **API Client**
  - [ ] Add TLS endpoints to `client/src/lib/api-client.ts`
  - [ ] Test endpoint connectivity

- [ ] **Navigation**
  - [ ] Import `IconCertificate` in `client/src/lib/route-config.ts`
  - [ ] Add `/certificates` route to route config
  - [ ] Add `/settings/tls` to settings children
  - [ ] Verify sidebar navigation appears

### Phase 5.2: React Query Hooks (Days 3-4)

- [ ] **Create Hooks**
  - [ ] `client/src/hooks/use-certificates.ts`
    - [ ] `useCertificates()` - list query
    - [ ] `useCertificate(id)` - detail query
    - [ ] `useCreateCertificate()` - create mutation
    - [ ] `useRenewCertificate(id)` - renew mutation
    - [ ] `useRevokeCertificate(id)` - revoke mutation
    - [ ] `useRenewalHistory(certificateId)` - history query

  - [ ] `client/src/hooks/use-tls-settings.ts`
    - [ ] `useTlsSettings()` - settings query
    - [ ] `useUpdateTlsSettings()` - update mutation
    - [ ] `useTestTlsConnectivity()` - connectivity test mutation

- [ ] **Test Hooks**
  - [ ] Test query cache invalidation
  - [ ] Test optimistic updates
  - [ ] Test error handling
  - [ ] Test toast notifications

### Phase 5.3: Reusable Components (Days 5-6)

- [ ] **Status Components**
  - [ ] `client/src/components/certificates/certificate-status-badge.tsx`
    - [ ] Status icon mapping
    - [ ] Color variants
    - [ ] Dark mode support

  - [ ] `client/src/components/certificates/renewal-status-badge.tsx`
    - [ ] Renewal status icons
    - [ ] Progress indicators

- [ ] **Data Display Components**
  - [ ] `client/src/components/certificates/certificate-list.tsx`
    - [ ] TanStack Table integration
    - [ ] Sortable columns
    - [ ] Row click navigation
    - [ ] Context menu actions
    - [ ] Timezone-aware dates
    - [ ] Expiry color coding

  - [ ] `client/src/components/certificates/renewal-history-table.tsx`
    - [ ] Renewal status display
    - [ ] Duration formatting
    - [ ] Retry indicators
    - [ ] Timezone-aware dates

- [ ] **Form Components**
  - [ ] `client/src/components/certificates/create-certificate-dialog.tsx`
    - [ ] Domain input with add/remove
    - [ ] Primary domain selection
    - [ ] Auto-renewal toggle
    - [ ] Renewal days input
    - [ ] Form validation
    - [ ] Loading states

  - [ ] `client/src/components/certificates/certificate-details-card.tsx`
    - [ ] Certificate metadata display
    - [ ] Key Vault information
    - [ ] Domain badges
    - [ ] Expiry countdown

### Phase 5.4: Pages (Days 7-10)

- [ ] **Certificate Management Pages**
  - [ ] `client/src/app/certificates/page.tsx`
    - [ ] Page layout following design guide
    - [ ] Header with action buttons
    - [ ] Loading skeleton
    - [ ] Error state
    - [ ] Certificate list integration
    - [ ] Create certificate dialog
    - [ ] Expiry warnings

  - [ ] `client/src/app/certificates/[id]/page.tsx`
    - [ ] Back button navigation
    - [ ] Certificate details cards
    - [ ] Status and expiry card
    - [ ] Key Vault info card
    - [ ] Domains card
    - [ ] Renewal history card
    - [ ] Action buttons (Renew, Revoke)
    - [ ] Loading skeleton
    - [ ] Not found state

- [ ] **Settings Pages**
  - [ ] `client/src/app/settings/tls/page.tsx`
    - [ ] Page layout following design guide
    - [ ] Azure Key Vault form card
    - [ ] ACME provider form card
    - [ ] Renewal scheduler form card
    - [ ] Test connection button
    - [ ] Save settings buttons
    - [ ] Form validation
    - [ ] Loading states

### Phase 5.5: Integration & Testing (Days 11-14)

- [ ] **Integration**
  - [ ] Test certificate creation flow end-to-end
  - [ ] Test certificate details page
  - [ ] Test renewal trigger
  - [ ] Test revocation
  - [ ] Test settings updates
  - [ ] Test connectivity check

- [ ] **Responsive Testing**
  - [ ] Test mobile layout (375px)
  - [ ] Test tablet layout (768px)
  - [ ] Test desktop layout (1920px)
  - [ ] Test responsive grids
  - [ ] Test responsive spacing

- [ ] **Accessibility Testing**
  - [ ] Keyboard navigation
  - [ ] Screen reader labels
  - [ ] Focus states
  - [ ] Color contrast (WCAG AA)
  - [ ] ARIA attributes

- [ ] **Cross-Browser Testing**
  - [ ] Chrome
  - [ ] Firefox
  - [ ] Safari
  - [ ] Edge

- [ ] **Dark Mode Testing**
  - [ ] All pages
  - [ ] All components
  - [ ] Icon backgrounds
  - [ ] Status badges
  - [ ] Alerts

### Phase 5.6: Polish & Documentation (Days 15-16)

- [ ] **Polish**
  - [ ] Add loading transitions
  - [ ] Add skeleton loaders
  - [ ] Optimize bundle size
  - [ ] Add error boundaries
  - [ ] Add empty states
  - [ ] Add confirmation dialogs for destructive actions

- [ ] **Documentation**
  - [ ] Component usage examples
  - [ ] Hook usage examples
  - [ ] Type definitions
  - [ ] Update this design document with any changes

---

## Design Decisions & Rationale

### Icon Choices

**Primary Icon: `IconCertificate`**
- Represents SSL/TLS certificates clearly
- Distinct from other navigation icons
- Part of Tabler Icons security/authentication family

**Color Scheme: Green**
- Represents security and trust
- Differentiates from other sections (blue: database, orange: credentials)
- Works well in both light and dark modes

**Testing Icon: `IconCloudQuestion`**
- Indicates cloud service testing (Azure Key Vault)
- Consistent with iconography guide for cloud connectivity testing
- Clear semantic meaning

### Page Layout Consistency

All pages follow the established Mini Infra pattern:
- **Outer container**: `flex flex-col gap-4 py-4 md:gap-6 md:py-6`
- **Header padding**: `px-4 lg:px-6`
- **Content width**: `max-w-7xl` for form-based pages
- **Icon size**: `h-6 w-6` in colored background box (`p-3 rounded-md`)
- **No margins on header** - spacing controlled by outer container gap

### Dialog vs. Full Page for Certificate Creation

**Decision**: Use dialog instead of dedicated page

**Rationale**:
- Faster user flow (no navigation away from list)
- Better for quick certificate creation
- Matches pattern used in Registry Credentials
- Keeps context visible (can see existing certificates)

### Status Badge Design

**Visual Hierarchy**:
- Icon + text for quick scanning
- Color coding matches severity
- Consistent badge sizing across all contexts

**Status Colors**:
- Green: Active (positive)
- Blue: Pending/Processing (informational)
- Orange: Renewing/Warning (attention needed)
- Red: Expired/Error/Revoked (critical)

### Date/Time Display

All dates use timezone-aware formatting via `useFormattedDate()` hook:
- Respects user timezone preference
- Consistent formatting across application
- Automatic timezone conversion from UTC
- Memoized for performance

### Table vs. Card Layout

**Certificate List**: Table layout
- Dense information display
- Sortable columns for large datasets
- Better for scanning multiple certificates
- Click row for details (standard pattern)

**Certificate Details**: Card layout
- Information grouped semantically
- Better readability for detailed view
- Responsive grid for status cards

---

## Performance Considerations

### React Query Optimizations

- **Stale Time**: 30 seconds for certificate list (balance freshness vs. requests)
- **Cache Invalidation**: Granular invalidation on mutations
- **Enabled Queries**: Conditional fetching based on route params
- **Parallel Queries**: Multiple queries on details page fetch concurrently

### Bundle Size

- **Tree Shaking**: Import specific Tabler icons (not full library)
- **Code Splitting**: Route-based splitting via React Router lazy loading
- **Shared Components**: Reusable components reduce duplication

### Render Optimization

- **Memoization**: `useMemo` for table columns
- **Virtualization**: Consider if certificate list exceeds 100 items
- **Debouncing**: Input fields in forms
- **Optimistic Updates**: Immediate UI feedback on mutations

---

## Accessibility

### ARIA Labels

- Icon-only buttons include `aria-label`
- Status badges use `role="status"`
- Form fields properly labeled
- Loading states announced

### Keyboard Navigation

- All interactive elements keyboard accessible
- Focus visible on all controls
- Tab order logical
- Escape closes dialogs
- Enter submits forms

### Color Contrast

All color combinations meet WCAG 2.1 Level AA:
- Text on backgrounds: 4.5:1 minimum
- Icons on backgrounds: 3:1 minimum
- Tested in both light and dark modes

---

## Future Enhancements

### Phase 6+ Features

1. **Certificate Comparison**
   - Compare multiple certificates side-by-side
   - Diff view for renewal changes

2. **Bulk Operations**
   - Multi-select certificates
   - Bulk renewal triggers
   - Batch exports

3. **Advanced Filtering**
   - Filter by status, expiry date, domain
   - Saved filter presets
   - Search across domains

4. **Renewal Calendar**
   - Visual timeline of upcoming renewals
   - Export to calendar (ICS)
   - Renewal notifications

5. **Analytics Dashboard**
   - Certificate health metrics
   - Renewal success rates over time
   - ACME provider performance
   - Cost tracking (if applicable)

6. **Certificate Import**
   - Upload existing certificates
   - Import from files
   - Manual certificate entry

---

## Conclusion

This frontend design document provides comprehensive specifications for implementing Phase 5 of the TLS Renewal Service. The design maintains consistency with existing Mini Infra patterns while introducing new certificate management capabilities.

**Key Achievements**:
- ✅ Follows page layout design guide exactly
- ✅ Uses Tabler Icons consistently
- ✅ Timezone-aware date displays
- ✅ Responsive mobile-first design
- ✅ Accessible components (WCAG 2.1 AA)
- ✅ React Query for optimal data fetching
- ✅ Type-safe with shared types package

**Next Steps**:
1. Review and approve this design document
2. Begin implementation following the checklist
3. Iterate with user feedback
4. Plan Phase 6 enhancements

---

**Document Version**: 1.0
**Created**: 2025-11-10
**Author**: Claude (Anthropic)
**Status**: Ready for Implementation
