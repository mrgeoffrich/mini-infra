import type { UseQueryResult } from "@tanstack/react-query";
import { IconAlertCircle, IconLoader2, IconSearch } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { formatBytes } from "./diagnostics-utils";
import { HEAP_SPACE_EXPLANATIONS } from "./diagnostics-explanations";
import type { MemoryDiagnostics, SmapsTopResponse } from "./diagnostics-types";

export function HeapSpacesTable({
  heapSpaces,
  showExplanations,
}: {
  heapSpaces: MemoryDiagnostics["heapSpaces"];
  showExplanations: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Heap Spaces</CardTitle>
        <CardDescription>Per-space allocation breakdown</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Space</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Physical</TableHead>
              {showExplanations && <TableHead>What it holds</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {heapSpaces.map((space) => (
              <TableRow key={space.name}>
                <TableCell className="font-mono text-xs">{space.name}</TableCell>
                <TableCell className="text-right">{formatBytes(space.used)}</TableCell>
                <TableCell className="text-right">{formatBytes(space.size)}</TableCell>
                <TableCell className="text-right">{formatBytes(space.available)}</TableCell>
                <TableCell className="text-right">{formatBytes(space.physical)}</TableCell>
                {showExplanations && (
                  <TableCell className="text-xs text-muted-foreground">
                    {HEAP_SPACE_EXPLANATIONS[space.name] ?? "—"}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function SmapsTopTable({
  smapsQuery,
  smapsLoaded,
  onLoadOrRefresh,
}: {
  smapsQuery: UseQueryResult<SmapsTopResponse>;
  smapsLoaded: boolean;
  onLoadOrRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Top Contributors to RSS</CardTitle>
            <CardDescription>
              /proc/self/smaps aggregated by mapped pathname. Accounts for shared libraries and mmap'd files.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadOrRefresh}
            disabled={smapsQuery.isFetching}
          >
            {smapsQuery.isFetching ? (
              <IconLoader2 className="h-4 w-4 animate-spin" />
            ) : (
              <IconSearch className="h-4 w-4" />
            )}
            {smapsLoaded ? "Refresh" : "Load"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {smapsQuery.isError && (
          <Alert variant="destructive" className="mb-4">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {smapsQuery.error instanceof Error
                ? smapsQuery.error.message
                : "Failed to load smaps"}
            </AlertDescription>
          </Alert>
        )}
        {!smapsLoaded && !smapsQuery.data && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Click Load to aggregate /proc/self/smaps by pathname.
          </p>
        )}
        {smapsQuery.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pathname</TableHead>
                <TableHead className="text-right">Regions</TableHead>
                <TableHead className="text-right">RSS</TableHead>
                <TableHead className="text-right">PSS</TableHead>
                <TableHead className="text-right">Private Dirty</TableHead>
                <TableHead className="text-right">Size</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {smapsQuery.data.groups.map((g) => (
                <TableRow key={g.pathname}>
                  <TableCell
                    className="max-w-md truncate font-mono text-xs"
                    title={g.pathname}
                  >
                    {g.pathname}
                  </TableCell>
                  <TableCell className="text-right">{g.regions}</TableCell>
                  <TableCell className="text-right">{formatBytes(g.rss)}</TableCell>
                  <TableCell className="text-right">{formatBytes(g.pss)}</TableCell>
                  <TableCell className="text-right">{formatBytes(g.privateDirty)}</TableCell>
                  <TableCell className="text-right">{formatBytes(g.size)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
