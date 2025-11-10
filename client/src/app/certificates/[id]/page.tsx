import {
  IconCertificate,
  IconRefresh,
  IconTrash,
  IconArrowLeft,
  IconCalendar,
  IconCloud,
} from "@tabler/icons-react";
import { useParams, useNavigate } from "react-router-dom";
import {
  useCertificate,
  useRenewalHistory,
  useRenewCertificate,
  useRevokeCertificate,
} from "@/hooks/use-certificates";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CertificateStatusBadge } from "@/components/certificates/certificate-status-badge";
import { RenewalHistoryTable } from "@/components/certificates/renewal-history-table";

export default function CertificateDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: certificate, isLoading } = useCertificate(id!);
  const { data: renewalHistory } = useRenewalHistory(id!);
  const { formatDateTime } = useFormattedDate();
  const { mutate: renewCertificate } = useRenewCertificate(id!);
  const { mutate: revokeCertificate } = useRevokeCertificate(id!);

  const handleRenewCertificate = () => {
    if (confirm("Are you sure you want to renew this certificate now?")) {
      renewCertificate();
    }
  };

  const handleRevokeCertificate = () => {
    if (
      confirm(
        "Are you sure you want to revoke this certificate? This action cannot be undone."
      )
    ) {
      revokeCertificate(undefined, {
        onSuccess: () => {
          navigate("/certificates");
        },
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-12 w-64" />
        </div>
      </div>
    );
  }

  if (!certificate) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <p>Certificate not found</p>
        </div>
      </div>
    );
  }

  const daysUntilExpiry = Math.floor(
    (new Date(certificate.notAfter).getTime() - Date.now()) /
      (1000 * 60 * 60 * 24)
  );

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header with back button */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/certificates")}
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
              <p className="text-muted-foreground">Certificate Details</p>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={handleRenewCertificate}>
              <IconRefresh className="h-4 w-4 mr-2" />
              Renew Now
            </Button>
            <Button variant="destructive" onClick={handleRevokeCertificate}>
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
                  <p className="mt-1 text-sm">
                    {formatDateTime(certificate.notAfter)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {daysUntilExpiry} days remaining
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Issued</label>
                  <p className="mt-1 text-sm">
                    {formatDateTime(certificate.issuedAt)}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Auto-Renewal</label>
                  <p className="mt-1 text-sm">
                    {certificate.autoRenew ? "✓ Enabled" : "✗ Disabled"}
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
                  <label className="text-sm font-medium">
                    Certificate Name
                  </label>
                  <p className="mt-1 text-sm font-mono">
                    {certificate.keyVaultCertificateName}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Version</label>
                  <p className="mt-1 text-sm font-mono">
                    {certificate.keyVaultVersion || "N/A"}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Provider</label>
                  <p className="mt-1 text-sm">
                    {certificate.acmeProvider || "N/A"}
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Issuer</label>
                  <p className="mt-1 text-sm">{certificate.issuer || "N/A"}</p>
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
              This certificate is valid for {certificate.domains.length} domain
              {certificate.domains.length !== 1 ? "s" : ""}
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
