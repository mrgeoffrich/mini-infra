import { useState } from "react";
import {
  IconCertificate,
  IconPlus,
  IconRefresh,
  IconAlertCircle,
} from "@tabler/icons-react";
import { useCertificates } from "@/hooks/use-certificates";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { CertificateList } from "@/components/certificates/certificate-list";
import { IssueCertificateDialog } from "@/components/certificates/issue-certificate-dialog";

function isExpiringWithin(expiryDate: Date, days: number): boolean {
  const daysUntilExpiry = Math.floor(
    (new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  return daysUntilExpiry <= days;
}

export default function CertificatesPage() {
  const { data: certificates, isLoading, error, refetch } = useCertificates();
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
            <Button onClick={() => setCreateDialogOpen(true)} data-tour="certificates-issue-button">
              <IconPlus className="h-4 w-4 mr-2" />
              Issue Certificate
            </Button>
          </div>
        </div>

        {/* Expiry warnings */}
        {certificates && certificates.some(cert => isExpiringWithin(cert.notAfter, 14)) && (
          <Alert variant="destructive" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              You have {certificates.filter(cert => isExpiringWithin(cert.notAfter, 14)).length} certificate(s) expiring within 14 days.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Certificate list */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card data-tour="certificates-list-card">
          <CardHeader>
            <CardTitle>Certificates</CardTitle>
            <CardDescription>
              {certificates?.length || 0} active certificate{certificates?.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CertificateList certificates={certificates || []} />
          </CardContent>
        </Card>
      </div>

      {/* Create certificate dialog */}
      <IssueCertificateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </div>
  );
}
