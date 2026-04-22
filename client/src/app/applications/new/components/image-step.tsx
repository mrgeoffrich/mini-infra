import { useState } from "react";
import { useFormContext } from "react-hook-form";
import { Link } from "react-router-dom";
import {
  IconAlertCircle,
  IconCheck,
  IconExternalLink,
  IconLoader2,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  useDetectImagePorts,
  type ImageValidationResult,
} from "@/hooks/use-detect-image-ports";
import type { CreateApplicationFormData } from "@/lib/application-schemas";

type RegistryChoice = "docker.io" | "ghcr.io" | "other";

interface Props {
  onValidated: (payload: { image: string; ports: number[] }) => void;
  onReset: () => void;
  validated: boolean;
}

function assembleImage(
  registry: RegistryChoice,
  customRegistry: string,
  containerName: string,
): string {
  const name = containerName.trim();
  if (registry === "docker.io") return name;
  if (registry === "ghcr.io") return `ghcr.io/${name}`;
  const host = customRegistry.trim().replace(/\/+$/, "");
  return host ? `${host}/${name}` : name;
}

export function ImageStep({ onValidated, onReset, validated }: Props) {
  const form = useFormContext<CreateApplicationFormData>();
  const detect = useDetectImagePorts();

  const [registry, setRegistry] = useState<RegistryChoice>("docker.io");
  const [customRegistry, setCustomRegistry] = useState("");
  const [containerName, setContainerName] = useState("");
  const [result, setResult] = useState<ImageValidationResult | null>(null);

  const tag = form.watch("dockerTag");

  const canValidate =
    containerName.trim().length > 0 &&
    tag.trim().length > 0 &&
    (registry !== "other" || customRegistry.trim().length > 0) &&
    !detect.isPending;

  const resetValidation = () => {
    setResult(null);
    if (validated) onReset();
  };

  const handleValidate = async () => {
    const fullImage = assembleImage(registry, customRegistry, containerName);
    const validation = await detect.mutateAsync({
      image: fullImage,
      tag: tag.trim(),
    });
    setResult(validation);

    if (validation.status === "success") {
      form.setValue("dockerImage", fullImage, { shouldValidate: true });
      onValidated({ image: fullImage, ports: validation.ports });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Container image</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr]">
          <div className="space-y-2">
            <Label>Registry</Label>
            <Select
              value={registry}
              onValueChange={(v) => {
                setRegistry(v as RegistryChoice);
                resetValidation();
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="docker.io">docker.io</SelectItem>
                <SelectItem value="ghcr.io">ghcr.io</SelectItem>
                <SelectItem value="other">Other…</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {registry === "other" && (
            <div className="space-y-2">
              <Label>Registry host</Label>
              <Input
                placeholder="quay.io"
                value={customRegistry}
                onChange={(e) => {
                  setCustomRegistry(e.target.value);
                  resetValidation();
                }}
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
          <div className="space-y-2">
            <Label>Container name</Label>
            <Input
              placeholder={
                registry === "docker.io"
                  ? "nginx or library/nginx"
                  : "owner/repo"
              }
              value={containerName}
              onChange={(e) => {
                setContainerName(e.target.value);
                resetValidation();
              }}
              data-tour="new-app-docker-image-input"
            />
          </div>

          <FormField
            control={form.control}
            name="dockerTag"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tag</FormLabel>
                <FormControl>
                  <Input
                    placeholder="latest"
                    {...field}
                    onChange={(e) => {
                      field.onChange(e);
                      resetValidation();
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button
          type="button"
          variant={validated ? "outline" : "default"}
          onClick={handleValidate}
          disabled={!canValidate}
        >
          {detect.isPending && (
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {validated ? "Re-validate" : "Validate"}
        </Button>

        {result && <ResultDisplay result={result} />}
      </CardContent>
    </Card>
  );
}

function ResultDisplay({ result }: { result: ImageValidationResult }) {
  if (result.status === "success") {
    return (
      <div className="flex items-start gap-3 rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm">
        <IconCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
        <div className="text-emerald-900 dark:text-emerald-100">
          <p className="font-medium">Image verified</p>
          <p className="mt-1">
            {result.ports.length === 0
              ? "No exposed ports detected in this image. You can configure ports manually below."
              : result.ports.length === 1
                ? `Detected exposed port: ${result.ports[0]}.`
                : `Detected exposed ports: ${result.ports.join(", ")}.`}
          </p>
        </div>
      </div>
    );
  }

  if (result.status === "auth-required") {
    return (
      <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
        <IconAlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-medium">Authentication required</p>
          <p className="mt-1 text-destructive/80">
            This registry requires credentials we don&apos;t have. Add a credential
            and try again.
          </p>
          <Link
            to="/settings/registry-credentials"
            className="mt-2 inline-flex items-center gap-1 underline"
          >
            Manage registry credentials
            <IconExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
      <IconAlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-medium">
          {result.status === "not-found" ? "Image not found" : "Validation failed"}
        </p>
        <p className="mt-1 text-destructive/80">{result.message}</p>
      </div>
    </div>
  );
}
