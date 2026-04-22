import { useFormContext } from "react-hook-form";
import { IconAlertTriangle, IconServer, IconWorld } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { StackServiceType } from "@mini-infra/types";
import type { CreateApplicationFormData } from "@/lib/application-schemas";

interface Props {
  showHaproxyWarning: boolean;
}

const OPTIONS: Array<{
  value: StackServiceType;
  label: string;
  description: string;
  icon: typeof IconWorld;
}> = [
  {
    value: "StatelessWeb",
    label: "Stateless web app",
    description: "Web server or API. Routed by HAProxy with zero-downtime deploys.",
    icon: IconWorld,
  },
  {
    value: "Stateful",
    label: "Stateful service",
    description: "Database, cache, or other persistent service. Stop/start replacement.",
    icon: IconServer,
  },
];

export function ServiceTypeStep({ showHaproxyWarning }: Props) {
  const form = useFormContext<CreateApplicationFormData>();
  const value = form.watch("serviceType");

  const setType = (next: StackServiceType) => {
    form.setValue("serviceType", next, { shouldValidate: true });
    form.setValue("serviceName", next === "StatelessWeb" ? "web" : "stateful", {
      shouldValidate: true,
    });
    form.setValue("enableRouting", next === "StatelessWeb", {
      shouldValidate: true,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service type</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = value === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setType(opt.value)}
                className={cn(
                  "flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4" />
                  <span className="font-medium">{opt.label}</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>

        {showHaproxyWarning && (
          <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">HAProxy stack required</p>
              <p className="mt-1 text-destructive/80">
                Stateless web applications require a deployed HAProxy stack with
                an applications network in this environment. Deploy an HAProxy
                stack in the environment&apos;s infrastructure first.
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
