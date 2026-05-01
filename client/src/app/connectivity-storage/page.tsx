import { useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IconAlertCircle,
  IconBrandAzure,
  IconBrandGoogleDrive,
  IconDatabase,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { StorageProviderId } from "@mini-infra/types";
import { StorageProviderPicker } from "@/components/storage/StorageProviderPicker";
import { StorageLocationSelector } from "@/components/storage/StorageLocationSelector";
import { StorageForgetProviderButton } from "@/components/storage/StorageForgetProviderButton";
import { AzureProviderConfig } from "@/components/storage/providers/azure/AzureProviderConfig";
import { GoogleDriveProviderConfig } from "@/components/storage/providers/google-drive/GoogleDriveProviderConfig";
import { StorageLocationList } from "@/components/storage/object-list";
import {
  STORAGE_SLOT_KEYS,
  StorageSlotKey,
  useAzureProviderConfig,
  useGoogleDriveProviderConfig,
  useStorageConnectivity,
  useStorageSettings,
  useUpdateActiveProvider,
  useUpdateStorageLocation,
} from "@/hooks/use-storage-settings";

export default function StorageSettingsPage() {
  const {
    data: storageSettings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useStorageSettings();
  const { data: connectivity } = useStorageConnectivity();
  const updateActiveProvider = useUpdateActiveProvider();

  const activeProviderId: StorageProviderId | null =
    storageSettings?.activeProviderId ?? null;
  const isStorageConnected = connectivity?.status === "connected";

  const handleProviderChange = useCallback(
    async (providerId: StorageProviderId) => {
      try {
        await updateActiveProvider.mutateAsync(providerId);
        toast.success(
          `Active storage provider set to ${providerId === "azure" ? "Azure Blob Storage" : "Google Drive"}`,
        );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to update active provider",
        );
      }
    },
    [updateActiveProvider],
  );

  if (settingsError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <PageHeader />
          <Alert variant="destructive" className="mt-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load storage settings: {settingsError.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <PageHeader />
      </div>

      <div className="px-4 lg:px-6 max-w-4xl space-y-6">
        {settingsLoading ? (
          <Skeleton className="h-32" />
        ) : (
          <StorageProviderPicker
            activeProviderId={activeProviderId}
            isUpdating={updateActiveProvider.isPending}
            onProviderChange={handleProviderChange}
          />
        )}

        {activeProviderId === "azure" && <AzureProviderConfig />}

        {activeProviderId === "google-drive" && <GoogleDriveProviderConfig />}

        {activeProviderId && !settingsLoading && (
          <>
            {isStorageConnected && activeProviderId === "azure" && (
              <div data-tour="storage-locations-list">
                <StorageLocationList provider="azure" />
              </div>
            )}

            <LocationAssignmentsCard
              provider={activeProviderId}
              locations={storageSettings?.locations ?? null}
              connected={isStorageConnected}
            />

            <InactiveProvidersCard activeProviderId={activeProviderId} />
          </>
        )}
      </div>
    </div>
  );
}

interface InactiveProvidersCardProps {
  activeProviderId: StorageProviderId;
}

/**
 * Renders a compact summary panel for each provider that is NOT the currently
 * active one, with a "Disconnect entirely" action. Only providers that still
 * hold credentials in Mini Infra are listed — others are skipped silently.
 */
function InactiveProvidersCard({
  activeProviderId,
}: InactiveProvidersCardProps) {
  const azureConfig = useAzureProviderConfig({
    enabled: activeProviderId !== "azure",
  });
  const driveConfig = useGoogleDriveProviderConfig({
    enabled: activeProviderId !== "google-drive",
  });

  const inactiveAzureConfigured =
    activeProviderId !== "azure" && !!azureConfig.data?.connectionConfigured;
  const inactiveDriveConfigured =
    activeProviderId !== "google-drive" &&
    !!driveConfig.data?.clientIdConfigured;

  if (!inactiveAzureConfigured && !inactiveDriveConfigured) {
    return null;
  }

  return (
    <Card data-tour="storage-inactive-providers">
      <CardHeader>
        <CardTitle>Other Configured Providers</CardTitle>
        <CardDescription>
          These providers still hold credentials in Mini Infra. Their backups
          remain restorable while configured. Disconnecting wipes the
          credentials and orphans any backup history rows that reference them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {inactiveAzureConfigured && (
          <InactiveProviderRow
            provider="azure"
            providerLabel="Azure Blob Storage"
            icon={IconBrandAzure}
            detail={
              azureConfig.data?.accountName
                ? `Account: ${azureConfig.data.accountName}`
                : "Configured"
            }
          />
        )}
        {inactiveDriveConfigured && (
          <InactiveProviderRow
            provider="google-drive"
            providerLabel="Google Drive"
            icon={IconBrandGoogleDrive}
            detail={
              driveConfig.data?.accountEmail
                ? `Account: ${driveConfig.data.accountEmail}`
                : "Configured"
            }
          />
        )}
      </CardContent>
    </Card>
  );
}

interface InactiveProviderRowProps {
  provider: StorageProviderId;
  providerLabel: string;
  icon: React.ComponentType<{ className?: string }>;
  detail: string;
}

function InactiveProviderRow({
  provider,
  providerLabel,
  icon: Icon,
  detail,
}: InactiveProviderRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3">
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5" />
        <div className="min-w-0">
          <div className="font-medium">{providerLabel}</div>
          <div className="text-sm text-muted-foreground truncate">
            {detail}
          </div>
        </div>
      </div>
      <StorageForgetProviderButton
        provider={provider}
        providerLabel={providerLabel}
      />
    </div>
  );
}

function PageHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
        <IconDatabase className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-3xl font-bold">Storage</h1>
        <p className="text-muted-foreground">
          Configure the storage backend used for postgres backups, self-backups,
          and TLS certificate material.
        </p>
      </div>
    </div>
  );
}

interface LocationAssignmentsCardProps {
  provider: StorageProviderId;
  locations: {
    postgresBackup: string | null;
    selfBackup: string | null;
    tlsCertificates: string | null;
  } | null;
  connected: boolean;
}

function LocationAssignmentsCard({
  provider,
  locations,
  connected,
}: LocationAssignmentsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage Location Assignments</CardTitle>
        <CardDescription>
          Pick the location used for each system function. Locations must
          already exist in the connected account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <PostgresBackupSlotRow
          provider={provider}
          value={locations?.postgresBackup ?? ""}
          disabled={!connected}
        />
        <SelfBackupSlotRow
          provider={provider}
          value={locations?.selfBackup ?? ""}
          disabled={!connected}
        />
        <TlsCertificateSlotRow
          provider={provider}
          value={locations?.tlsCertificates ?? ""}
          disabled={!connected}
        />
      </CardContent>
    </Card>
  );
}

interface SlotRowProps {
  provider: StorageProviderId;
  value: string;
  disabled: boolean;
}

interface SlotRowFrameProps {
  slot: StorageSlotKey;
  label: string;
  description: string;
  children: (
    handleChange: (locationId: string) => Promise<void>,
    isPending: boolean,
  ) => React.ReactNode;
}

function SlotRowFrame({
  slot,
  label,
  description,
  children,
}: SlotRowFrameProps) {
  const updateSlot = useUpdateStorageLocation(slot);

  const handleChange = useCallback(
    async (locationId: string) => {
      try {
        await updateSlot.mutateAsync(locationId);
        toast.success(`${label} updated successfully`);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : `Failed to save ${label.toLowerCase()}`,
        );
      }
    },
    [label, updateSlot],
  );

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <p className="text-xs text-muted-foreground">{description}</p>
      {children(handleChange, updateSlot.isPending)}
    </div>
  );
}

// Each slot renders its selector with a static `data-tour` attribute so the
// UI manifest scanner (`scripts/generate-ui-manifest.mjs`) can pick the IDs
// up. The scanner can't follow dynamic `data-tour={tourId}` props.
function PostgresBackupSlotRow({ provider, value, disabled }: SlotRowProps) {
  return (
    <SlotRowFrame
      slot={STORAGE_SLOT_KEYS.POSTGRES_BACKUP}
      label="Default Postgres Backup Location"
      description="Pre-selected when setting up new database backup configurations."
    >
      {(handleChange, isPending) => (
        <div data-tour="storage-postgres-backup-location-selector">
          <StorageLocationSelector
            provider={provider}
            value={value}
            onChange={handleChange}
            disabled={disabled || isPending}
            placeholder={
              provider === "azure"
                ? "Select a container..."
                : "Select a folder..."
            }
          />
        </div>
      )}
    </SlotRowFrame>
  );
}

function SelfBackupSlotRow({ provider, value, disabled }: SlotRowProps) {
  return (
    <SlotRowFrame
      slot={STORAGE_SLOT_KEYS.SELF_BACKUP}
      label="Self-Backup Location"
      description="Where Mini Infra stores its own database backups."
    >
      {(handleChange, isPending) => (
        <div data-tour="storage-self-backup-location-selector">
          <StorageLocationSelector
            provider={provider}
            value={value}
            onChange={handleChange}
            disabled={disabled || isPending}
            placeholder={
              provider === "azure"
                ? "Select a container..."
                : "Select a folder..."
            }
          />
        </div>
      )}
    </SlotRowFrame>
  );
}

function TlsCertificateSlotRow({ provider, value, disabled }: SlotRowProps) {
  return (
    <SlotRowFrame
      slot={STORAGE_SLOT_KEYS.TLS_CERTIFICATES}
      label="TLS Certificate Location"
      description="Where TLS certificates and private keys are stored."
    >
      {(handleChange, isPending) => (
        <div data-tour="storage-tls-location-selector">
          <StorageLocationSelector
            provider={provider}
            value={value}
            onChange={handleChange}
            disabled={disabled || isPending}
            placeholder={
              provider === "azure"
                ? "Select a container..."
                : "Select a folder..."
            }
          />
        </div>
      )}
    </SlotRowFrame>
  );
}
