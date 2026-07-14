import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { IconAlertTriangle, IconExternalLink } from "@tabler/icons-react";
import { useStackHistory } from "@/hooks/use-stacks";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { StackDeploymentRecord } from "@mini-infra/types";
import { StatusStrip } from "../_components/status-strip";
import { ConnectCard } from "../_components/connect-card";
import { ConnectedNetworksCard } from "../_components/connected-networks-card";
import { AddonsCard } from "../_components/addons-card";
import type { ApplicationDetailContext } from "../layout";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec - min * 60);
  return `${min}m ${remSec}s`;
}

function ActivityRow({ entry }: { entry: StackDeploymentRecord }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <Badge variant={entry.success ? "default" : "destructive"}>
          {entry.action}
        </Badge>
        {entry.version != null && (
          <span className="text-muted-foreground text-xs">v{entry.version}</span>
        )}
        <span className="truncate">
          {entry.success ? "succeeded" : (entry.error ?? "failed")}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
        <span>{formatDuration(entry.duration)}</span>
        <span>{formatDateTime(entry.createdAt)}</span>
      </div>
    </li>
  );
}

export default function ApplicationOverviewTab() {
  const navigate = useNavigate();
  const { template, primaryStack, containerStatus, environment, url, stacks } =
    useOutletContext<ApplicationDetailContext>();

  const { data: historyData } = useStackHistory(primaryStack?.id ?? "");
  const recent = (historyData?.data ?? []).slice(0, 5);

  const hasStacks = stacks.length > 0;
  const lastFailure = primaryStack?.lastFailureReason ?? null;

  return (
    <div className="grid gap-6 max-w-4xl">
      <StatusStrip stack={primaryStack} containerStatus={containerStatus} />

      {lastFailure && (
        <Alert variant="destructive">
          <IconAlertTriangle className="h-4 w-4" />
          <AlertTitle>Last apply failed</AlertTitle>
          <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {lastFailure}
          </AlertDescription>
        </Alert>
      )}

      {hasStacks && (
        <ConnectCard
          stackId={primaryStack?.id}
          stackName={primaryStack?.name}
          envName={environment?.name}
        />
      )}

      {hasStacks && (
        <ConnectedNetworksCard
          stackId={primaryStack?.id}
          services={primaryStack?.services}
          templateId={template.id}
          template={template}
        />
      )}

      {/* Unlike the Connect / Connected-Networks cards (gated behind an applied
          snapshot), the Add-ons card renders whenever the app has a template
          version — so operators can attach addons at config time, before the
          first deploy. */}
      <AddonsCard templateId={template.id} template={template} />

      {!hasStacks && (
        <Card>
          <CardHeader>
            <CardTitle>Not deployed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {template.environmentId
                ? "This application is configured but has not been deployed yet. Use Deploy above to bring it up."
                : "Bind this application to an environment before deploying."}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="font-medium">
                  {environment?.name ?? "—"}
                  {environment && (
                    <span className="ml-1 text-muted-foreground font-normal">
                      ({environment.networkType})
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Public URL</dt>
                <dd className="font-medium">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {url.replace("https://", "")}
                      <IconExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              {primaryStack && (
                <div>
                  <dt className="text-muted-foreground">Installed as stack</dt>
                  <dd className="font-medium">
                    <Link
                      to={`/stacks/${primaryStack.id}`}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {primaryStack.name}
                      <IconExternalLink className="h-3.5 w-3.5" />
                    </Link>
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">Last applied</dt>
                <dd className="font-medium">
                  {formatDateTime(primaryStack?.lastAppliedAt ?? null)}
                  {primaryStack?.lastAppliedVersion != null && (
                    <span className="ml-1 text-muted-foreground font-normal">
                      (v{primaryStack.lastAppliedVersion})
                    </span>
                  )}
                </dd>
              </div>
              {primaryStack?.lastAppliedSnapshot?.services?.length ? (
                <div>
                  <dt className="text-muted-foreground">Images</dt>
                  <dd className="font-mono text-xs space-y-0.5">
                    {primaryStack.lastAppliedSnapshot.services.map((s) => (
                      <div key={s.serviceName} className="truncate">
                        {s.dockerImage}:{s.dockerTag}
                      </div>
                    ))}
                  </dd>
                </div>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No deployment history yet.
              </p>
            ) : (
              <>
                <ul className="divide-y">
                  {recent.map((entry) => (
                    <ActivityRow key={entry.id} entry={entry} />
                  ))}
                </ul>
                <div className="mt-3 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      navigate(`/applications/${template.id}/activity`)
                    }
                  >
                    View full history
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
