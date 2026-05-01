import { Fragment, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconLoader2,
  IconX,
} from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStackHistory } from "@/hooks/use-stacks";
import type { StackDeploymentRecord } from "@mini-infra/types";
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

function HistoryRow({ entry }: { entry: StackDeploymentRecord }) {
  const [expanded, setExpanded] = useState(false);
  const serviceResults = entry.serviceResults ?? [];
  const resourceResults = entry.resourceResults ?? [];
  const hasDetails =
    serviceResults.length > 0 ||
    resourceResults.length > 0 ||
    !!entry.error;

  return (
    <Fragment>
      <TableRow>
        <TableCell className="w-8 align-top">
          {hasDetails && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <IconChevronDown className="h-4 w-4" />
              ) : (
                <IconChevronRight className="h-4 w-4" />
              )}
            </Button>
          )}
        </TableCell>
        <TableCell className="text-sm whitespace-nowrap">
          {formatDateTime(entry.createdAt)}
        </TableCell>
        <TableCell>
          <Badge variant={entry.success ? "default" : "destructive"}>
            {entry.action}
          </Badge>
        </TableCell>
        <TableCell>
          {entry.success ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <IconCheck className="h-4 w-4" /> success
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-destructive">
              <IconX className="h-4 w-4" /> failed
            </span>
          )}
        </TableCell>
        <TableCell className="text-sm">
          {entry.version != null ? `v${entry.version}` : "—"}
        </TableCell>
        <TableCell className="text-sm">
          {formatDuration(entry.duration)}
        </TableCell>
        <TableCell className="text-sm text-muted-foreground">
          {entry.triggeredBy ?? "—"}
        </TableCell>
      </TableRow>
      {expanded && hasDetails && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30">
            <div className="grid gap-4 md:grid-cols-2 py-2">
              {entry.error && (
                <div className="md:col-span-2">
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Error
                  </div>
                  <pre className="text-xs font-mono whitespace-pre-wrap text-destructive">
                    {entry.error}
                  </pre>
                </div>
              )}
              {serviceResults.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Services ({serviceResults.length})
                  </div>
                  <ul className="text-xs grid gap-0.5">
                    {serviceResults.map((r, i) => (
                      <li
                        key={`${r.serviceName}-${i}`}
                        className="flex items-center gap-2"
                      >
                        <span
                          className={cn(
                            "font-mono",
                            r.success
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-destructive",
                          )}
                        >
                          {r.action}
                        </span>
                        <span className="font-medium">{r.serviceName}</span>
                        <span className="text-muted-foreground ml-auto">
                          {formatDuration(r.duration)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {resourceResults.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Resources ({resourceResults.length})
                  </div>
                  <ul className="text-xs grid gap-0.5">
                    {resourceResults.map((r, i) => (
                      <li
                        key={`${r.resourceType}-${r.resourceName}-${i}`}
                        className="flex items-center gap-2"
                      >
                        <span
                          className={cn(
                            "font-mono",
                            r.success
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-destructive",
                          )}
                        >
                          {r.action}
                        </span>
                        <span className="text-muted-foreground">
                          {r.resourceType}
                        </span>
                        <span className="font-medium truncate">
                          {r.resourceName}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}

export default function ApplicationHistoryTab() {
  const { primaryStack } = useOutletContext<ApplicationDetailContext>();
  const stackId = primaryStack?.id ?? "";
  const { data, isLoading } = useStackHistory(stackId);
  const entries = data?.data ?? [];

  if (!primaryStack) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            No deployment history yet. Deploy this application to see entries
            here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deployment history</CardTitle>
        <CardDescription>
          Apply, stop, and destroy operations on this stack. Expand a row to see
          per-service and per-resource detail.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <IconLoader2 className="h-4 w-4 animate-spin" />
            Loading history…
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No history records yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Triggered by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
