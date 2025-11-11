import { useTLSCertificates } from "@/hooks/use-manual-haproxy-frontend";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { IconShield, IconAlertTriangle } from "@tabler/icons-react";
import { format } from "date-fns";

interface SSLCertificateSelectProps {
  environmentId: string;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Certificate selection dropdown with status and expiry info
 *
 * Uses useTLSCertificates() hook
 * Displays each certificate with:
 * - Primary domain
 * - Status badge
 * - Expiry date (with warning if < 30 days)
 * - Disabled if status !== 'ACTIVE'
 */
export function SSLCertificateSelect({
  environmentId,
  value,
  onChange,
  disabled = false,
}: SSLCertificateSelectProps) {
  const { data: certificates, isLoading } = useTLSCertificates(environmentId);

  if (isLoading) {
    return (
      <Select disabled>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Loading certificates..." />
        </SelectTrigger>
      </Select>
    );
  }

  const activeCertificates = certificates?.filter(
    (cert) => cert.status === "ACTIVE",
  );

  if (!activeCertificates || activeCertificates.length === 0) {
    return (
      <Select disabled>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="No active certificates available" />
        </SelectTrigger>
      </Select>
    );
  }

  const getCertificateWarning = (notAfter: Date): boolean => {
    const expiryDate = new Date(notAfter);
    const daysUntilExpiry = Math.ceil(
      (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );
    return daysUntilExpiry < 30;
  };

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select a certificate">
          {value && (
            <div className="flex items-center gap-2">
              <IconShield className="w-4 h-4 text-green-600 dark:text-green-500" />
              <span>
                {
                  activeCertificates.find((cert) => cert.id === value)
                    ?.primaryDomain
                }
              </span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {activeCertificates.map((cert) => {
          const hasWarning = getCertificateWarning(cert.notAfter);
          const expiryDate = new Date(cert.notAfter);

          return (
            <SelectItem key={cert.id} value={cert.id}>
              <div className="flex items-center justify-between w-full gap-3">
                <div className="flex items-center gap-2 flex-1">
                  <IconShield className="w-4 h-4 text-green-600 dark:text-green-500 flex-shrink-0" />
                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {cert.primaryDomain}
                    </span>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {hasWarning && (
                        <IconAlertTriangle className="w-3 h-3 text-yellow-600 dark:text-yellow-500" />
                      )}
                      <span>
                        Expires: {format(expiryDate, "MMM dd, yyyy")}
                      </span>
                    </div>
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950 flex-shrink-0"
                >
                  {cert.status}
                </Badge>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
