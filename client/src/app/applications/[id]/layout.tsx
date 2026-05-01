import { useMemo } from "react";
import {
  NavLink,
  Outlet,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  IconAlertCircle,
  IconArrowLeft,
  IconExternalLink,
} from "@tabler/icons-react";
import {
  useApplication,
  useUserStacks,
} from "@/hooks/use-applications";
import { useStackStatus } from "@/hooks/use-stacks";
import { useEnvironments } from "@/hooks/use-environments";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import type {
  Environment,
  StackContainerStatus,
  StackInfo,
  StackTemplateInfo,
} from "@mini-infra/types";

export interface ApplicationDetailContext {
  templateId: string;
  template: StackTemplateInfo;
  stacks: StackInfo[];
  primaryStack: StackInfo | null;
  /** Live container status for the primary stack — empty array when no stack or Docker is unreachable. */
  containerStatus: StackContainerStatus[];
  environment: Environment | undefined;
  url: string | null;
}

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "services", label: "Services" },
  { value: "routing", label: "Routing" },
  { value: "pool", label: "Pool" },
  { value: "monitoring", label: "Monitoring" },
  { value: "history", label: "History" },
  { value: "configuration", label: "Configuration" },
] as const;

function pickPrimaryStack(stacks: StackInfo[]): StackInfo | null {
  return (
    stacks.find((s) => s.status === "synced")
      ?? stacks.find((s) => s.status === "pending")
      ?? stacks[0]
      ?? null
  );
}

function getAppUrl(stack: StackInfo | null): string | null {
  if (!stack || stack.status !== "synced") return null;
  const fqdn = stack.tunnelIngress?.[0]?.fqdn ?? stack.dnsRecords?.[0]?.fqdn;
  return fqdn ? `https://${fqdn}` : null;
}

export default function ApplicationDetailLayout() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const { data: appData, isLoading, error } = useApplication(id ?? "");
  const { data: stacksData } = useUserStacks();
  const { data: envData } = useEnvironments();

  const template = appData?.data ?? null;
  const stacks = useMemo(() => {
    const all = stacksData?.data ?? [];
    return template ? all.filter((s) => s.templateId === template.id) : [];
  }, [stacksData, template]);
  const primaryStack = useMemo(() => pickPrimaryStack(stacks), [stacks]);
  const { data: stackStatusData } = useStackStatus(primaryStack?.id ?? "");
  const containerStatus = stackStatusData?.data?.containerStatus ?? [];
  const environment = useMemo(() => {
    const envs = envData?.environments ?? [];
    return template?.environmentId
      ? envs.find((e) => e.id === template.environmentId)
      : undefined;
  }, [envData, template]);
  const url = useMemo(() => getAppUrl(primaryStack), [primaryStack]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-8 w-48 mb-4" />
          <Skeleton className="h-10 w-80" />
          <Skeleton className="h-5 w-96 mt-2" />
        </div>
        <div className="px-4 lg:px-6 max-w-3xl space-y-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !template || !id) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/applications")}
            className="mb-4"
          >
            <IconArrowLeft className="h-4 w-4 mr-1" />
            Back to Applications
          </Button>
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {error?.message ?? "Failed to load application."}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const stackStatus = primaryStack?.status;
  const statusBadge = !primaryStack ? (
    <Badge variant="outline">Not deployed</Badge>
  ) : stackStatus === "synced" ? (
    <Badge>Running</Badge>
  ) : stackStatus === "error" ? (
    <Badge variant="destructive">Error</Badge>
  ) : (
    <Badge variant="outline">{stackStatus}</Badge>
  );

  const context: ApplicationDetailContext = {
    templateId: id,
    template,
    stacks,
    primaryStack,
    containerStatus,
    environment,
    url,
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/applications")}
          className="mb-4"
        >
          <IconArrowLeft className="h-4 w-4 mr-1" />
          Back to Applications
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold truncate">
              {template.displayName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {statusBadge}
              {environment && (
                <Badge variant="outline">
                  {environment.name}
                  <span className="ml-1 text-muted-foreground">
                    ({environment.networkType})
                  </span>
                </Badge>
              )}
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {url.replace("https://", "")}
                  <IconExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {template.description && (
              <p className="text-muted-foreground mt-2 max-w-2xl">
                {template.description}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <nav
          aria-label="Application detail tabs"
          className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]"
        >
          {TABS.map((t) => (
            <NavLink
              key={t.value}
              to={`/applications/${id}/${t.value}`}
              end
              className={({ isActive }) =>
                cn(
                  "inline-flex h-[calc(100%-1px)] items-center justify-center rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
                  isActive
                    ? "bg-background text-foreground shadow-sm dark:bg-input/30 dark:border-input dark:text-foreground"
                    : "text-foreground hover:text-foreground dark:text-muted-foreground",
                )
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="px-4 lg:px-6">
        <Outlet context={context} />
      </div>
    </div>
  );
}
