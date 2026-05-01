import React, { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  IconBrandGoogleDrive,
  IconCircleCheck,
  IconCircleX,
  IconFolderPlus,
  IconLoader2,
} from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useCreateGoogleDriveFolder,
  useGoogleDriveProviderConfig,
  useTestStorageLocationAccess,
} from "@/hooks/use-storage-settings";
import { extractGoogleDriveFolderId } from "./folder-id-utils";

export interface GoogleDriveFolderInputProps {
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export const GoogleDriveFolderInput = React.memo(
  function GoogleDriveFolderInput({
    value,
    onChange,
    disabled = false,
    placeholder = "Paste folder ID or Drive folder URL",
    className,
  }: GoogleDriveFolderInputProps) {
    const { data: config } = useGoogleDriveProviderConfig();
    const isConnected = !!config?.isConnected;
    // Track the upstream `value` to detect external resets and re-derive the
    // draft + validation state without setState-in-effect.
    const [lastExternalValue, setLastExternalValue] = useState(value ?? "");
    const [draftOverride, setDraftOverride] = useState<string | null>(null);
    const [validationError, setValidationError] = useState<string | null>(null);
    const [internallyValidated, setInternallyValidated] = useState<{
      id: string;
      name: string | null;
    } | null>(null);

    const testLocation = useTestStorageLocationAccess("google-drive");
    const createFolder = useCreateGoogleDriveFolder();

    if ((value ?? "") !== lastExternalValue) {
      // External value changed — re-baseline derived state in the same render.
      setLastExternalValue(value ?? "");
      setDraftOverride(null);
      setInternallyValidated(null);
      setValidationError(null);
    }

    const draft = draftOverride ?? (value ?? "");
    const setDraft = (next: string) => setDraftOverride(next);

    const validatedId = internallyValidated?.id ?? value ?? null;
    const validatedName = internallyValidated?.name ?? null;

    const extractedId = useMemo(() => extractGoogleDriveFolderId(draft), [draft]);

    const handleValidate = async () => {
      const folderId = extractGoogleDriveFolderId(draft);
      if (!folderId) {
        setValidationError("Couldn't parse a folder id from that value");
        setInternallyValidated(null);
        return;
      }
      setValidationError(null);
      try {
        const info = await testLocation.mutateAsync(folderId);
        if (info.accessible) {
          setInternallyValidated({ id: folderId, name: info.displayName });
          onChange(folderId);
          toast.success(
            `Validated folder "${info.displayName}" — Mini Infra can write here`,
          );
        } else {
          const errorCode =
            (info.metadata as { errorCode?: string } | undefined)?.errorCode ??
            "unknown";
          const errorText =
            errorCode === "FOLDER_NOT_ACCESSIBLE"
              ? "Folder not accessible — drive.file scope can only see folders Mini Infra created. Use 'Create folder via Mini Infra' below, or share the folder with the Mini Infra app from Drive."
              : `Folder validation failed (${errorCode})`;
          setValidationError(errorText);
          setInternallyValidated(null);
          toast.error(errorText);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setValidationError(message);
        setInternallyValidated(null);
        toast.error(`Validation failed: ${message}`);
      }
    };

    if (!isConnected) {
      return (
        <div className={className}>
          <Alert>
            <IconBrandGoogleDrive className="h-4 w-4" />
            <AlertDescription>
              Connect Google Drive first — see the provider config above.
            </AlertDescription>
          </Alert>
        </div>
      );
    }

    return (
      <div className={`space-y-2 ${className ?? ""}`}>
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={disabled || testLocation.isPending}
            data-tour="storage-google-drive-folder-input"
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleValidate}
            disabled={
              disabled || testLocation.isPending || !extractedId || !draft
            }
            data-tour="storage-google-drive-validate-folder"
          >
            {testLocation.isPending ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Validate"
            )}
          </Button>
          <CreateFolderDialog
            disabled={disabled || createFolder.isPending}
            onCreated={(info) => {
              setDraft(info.id);
              setInternallyValidated({ id: info.id, name: info.displayName });
              setValidationError(null);
              onChange(info.id);
            }}
          />
        </div>
        {extractedId && extractedId !== draft.trim() && (
          <p className="text-xs text-muted-foreground">
            Detected folder id: <code>{extractedId}</code>
          </p>
        )}
        {validatedId && !validationError && (
          <p className="flex items-center gap-1 text-xs text-green-700 dark:text-green-300">
            <IconCircleCheck className="h-3 w-3" />
            Active folder: {validatedName ?? validatedId}
          </p>
        )}
        {validationError && (
          <Alert variant="destructive">
            <IconCircleX className="h-4 w-4" />
            <AlertDescription>{validationError}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  },
);

interface CreateFolderDialogProps {
  disabled?: boolean;
  onCreated: (info: { id: string; displayName: string }) => void;
}

function CreateFolderDialog({ disabled, onCreated }: CreateFolderDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const createFolder = useCreateGoogleDriveFolder();

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const info = await createFolder.mutateAsync(trimmed);
      onCreated({ id: info.id, displayName: info.displayName });
      toast.success(`Created folder "${info.displayName}" in your Drive`);
      setName("");
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to create folder: ${message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          data-tour="storage-google-drive-create-folder"
        >
          <IconFolderPlus className="h-4 w-4" />
          Create folder
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a Drive folder</DialogTitle>
          <DialogDescription>
            Mini Infra will create a folder in the connected Google account
            using the <code>drive.file</code> scope, so it remains visible to
            Mini Infra after creation.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="mini-infra-backups"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={createFolder.isPending}
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={createFolder.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={createFolder.isPending || !name.trim()}
          >
            {createFolder.isPending && (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
