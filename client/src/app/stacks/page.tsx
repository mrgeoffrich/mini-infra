import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { IconRefresh, IconStack2 } from "@tabler/icons-react";
import { useAllStacks, useStackStatusEvents } from "@/hooks/use-stacks";
import { useEnvironments } from "@/hooks/use-environments";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { getStackAttention } from "@/lib/stack-attention";
import { StackStatusBadge } from "@/components/stacks/StackStatusBadge";
import {
  NeedsAttentionBadge,
  UpdateAvailableBadge,
} from "@/components/stacks/stack-indicators";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { StackInfo } from "@mini-infra/types";

type ScopeFilter = "all" | "host" | "environment";
type SourceFilter = "all" | "system" | "user" | "manual";
type StatusFilter =
  | "all"
  | "synced"
  | "drifted"
  | "pending"
  | "error"
  | "undeployed";

function sourceLabel(stack: StackInfo): string {
  if (stack.templateSource === "user") return "Application";
  if (stack.templateSource === "system") return "Infrastructure";
  return "Manual";
}

export default function StacksPage() {
  const [searchParams] = useSearchParams();
  const { formatDateTime } = useFormattedDate();
  const { data, isLoading, isError, error, refetch, isRefetching } = useAllStacks();
  const { data: envData } = useEnvironments();
  // Live status pushes keep the list current without polling.
  useStackStatusEvents();

  const envNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const env of envData?.environments ?? []) map.set(env.id, env.name);
    return map;
  }, [envData]);

  const [q, setQ] = useState(searchParams.get("q") ?? "");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [attentionOnly, setAttentionOnly] = useState(false);

  const stacks = useMemo(() => data?.data ?? [], [data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stacks.filter((s) => {
      if (needle && !s.name.toLowerCase().includes(needle)) return false;
      if (scope === "host" && s.environmentId !== null) return false;
      if (scope === "environment" && s.environmentId === null) return false;
      if (source !== "all") {
        const src =
          s.templateSource === "user"
            ? "user"
            : s.templateSource === "system"
              ? "system"
              : "manual";
        if (src !== source) return false;
      }
      if (status !== "all" && s.status !== status) return false;
      if (attentionOnly && !getStackAttention(s).needsAttention) return false;
      return true;
    });
  }, [stacks, q, scope, source, status, attentionOnly]);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-purple-100 p-2 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconStack2 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Stacks</h1>
              <p className="text-sm text-muted-foreground">
                Every stack across host and environment scopes — infrastructure
                and applications alike.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <IconRefresh className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <Card>
          <CardContent className="space-y-4 pt-6">
            {/* Filters */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <Label className="text-xs">Search</Label>
                <Input
                  placeholder="Filter by name…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="h-9"
                />
              </div>
              <div>
                <Label className="text-xs">Scope</Label>
                <Select value={scope} onValueChange={(v) => setScope(v as ScopeFilter)}>
                  <SelectTrigger className="h-9 w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All scopes</SelectItem>
                    <SelectItem value="host">Host</SelectItem>
                    <SelectItem value="environment">Environment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Source</Label>
                <Select value={source} onValueChange={(v) => setSource(v as SourceFilter)}>
                  <SelectTrigger className="h-9 w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    <SelectItem value="system">Infrastructure</SelectItem>
                    <SelectItem value="user">Application</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                  <SelectTrigger className="h-9 w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="synced">Synced</SelectItem>
                    <SelectItem value="drifted">Drifted</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                    <SelectItem value="undeployed">Undeployed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 pb-1.5">
                <Switch
                  id="attention-only"
                  checked={attentionOnly}
                  onCheckedChange={setAttentionOnly}
                />
                <Label htmlFor="attention-only" className="text-xs">
                  Needs attention
                </Label>
              </div>
            </div>

            {isError ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Failed to load stacks:{" "}
                  {error instanceof Error ? error.message : "Unknown error"}
                </AlertDescription>
              </Alert>
            ) : isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                No stacks match the current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Template version</TableHead>
                      <TableHead>Attention</TableHead>
                      <TableHead>Last applied</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((stack) => (
                      <TableRow key={stack.id}>
                        <TableCell>
                          <Link
                            to={`/stacks/${stack.id}`}
                            className="font-medium hover:underline"
                          >
                            {stack.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-sm">
                          {stack.environmentId === null
                            ? "Host"
                            : envNameById.get(stack.environmentId) ?? "Environment"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {stack.templateSource === "user" && stack.templateId ? (
                            <Link
                              to={`/applications/${stack.templateId}`}
                              className="hover:underline"
                            >
                              Application
                            </Link>
                          ) : (
                            sourceLabel(stack)
                          )}
                        </TableCell>
                        <TableCell>
                          <StackStatusBadge status={stack.status} />
                        </TableCell>
                        <TableCell className="text-sm">
                          {stack.templateVersion != null ? (
                            <span className="inline-flex items-center gap-2">
                              <span className="font-mono">v{stack.templateVersion}</span>
                              {stack.templateCurrentVersion != null &&
                                stack.templateCurrentVersion !== stack.templateVersion && (
                                  <span className="text-muted-foreground">
                                    / latest v{stack.templateCurrentVersion}
                                  </span>
                                )}
                              {stack.templateUpdateAvailable && <UpdateAvailableBadge />}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <NeedsAttentionBadge stack={stack} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {stack.lastAppliedAt ? formatDateTime(stack.lastAppliedAt) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
