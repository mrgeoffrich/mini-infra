import type { UseQueryResult } from "@tanstack/react-query";
import { IconAlertCircle, IconEye, IconLoader2, IconSearch } from "@tabler/icons-react";
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
import type {
  SmapsRegion,
  SmapsRegionGroup,
  SmapsRegionsResponse,
  PeekResult,
} from "./diagnostics-types";

export function RegionInspectPanel({
  regionsQuery,
  smapsGroups,
  inspectPathname,
  onPathnameChange,
  inspectPeek,
  peekingStart,
  onPeek,
}: {
  regionsQuery: UseQueryResult<SmapsRegionsResponse>;
  smapsGroups: SmapsRegionGroup[] | undefined;
  inspectPathname: string;
  onPathnameChange: (pathname: string) => void;
  inspectPeek: PeekResult | null;
  peekingStart: string | null;
  onPeek: (region: SmapsRegion) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Inspect Memory Region</CardTitle>
            <CardDescription>
              Pick a pathname, load its top regions by RSS, then peek one to
              extract printable strings from /proc/self/mem. Helpful for
              guessing what&apos;s living in an anonymous region (SQL text, JSON
              payloads, identifier patterns, etc.).
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <select
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={inspectPathname}
              onChange={(e) => onPathnameChange(e.target.value)}
            >
              <option value="[anon]">[anon]</option>
              <option value="[heap]">[heap]</option>
              <option value="[stack]">[stack]</option>
              {smapsGroups
                ?.filter(
                  (g) => !["[anon]", "[heap]", "[stack]"].includes(g.pathname),
                )
                .map((g) => (
                  <option key={g.pathname} value={g.pathname}>
                    {g.pathname}
                  </option>
                ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => regionsQuery.refetch()}
              disabled={regionsQuery.isFetching}
            >
              {regionsQuery.isFetching ? (
                <IconLoader2 className="h-4 w-4 animate-spin" />
              ) : (
                <IconSearch className="h-4 w-4" />
              )}
              Find regions
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {regionsQuery.isError && (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              {regionsQuery.error instanceof Error
                ? regionsQuery.error.message
                : "Failed to load regions"}
            </AlertDescription>
          </Alert>
        )}

        {!regionsQuery.data && !regionsQuery.isFetching && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Pick a pathname (defaults to [anon] — the bulk of your RSS) and
            click Find regions.
          </p>
        )}

        {regionsQuery.data && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Perms</TableHead>
                <TableHead className="text-right">RSS</TableHead>
                <TableHead className="text-right">PSS</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {regionsQuery.data.regions.map((r) => (
                <TableRow key={`${r.start}-${r.end}`}>
                  <TableCell className="font-mono text-xs">0x{r.start}</TableCell>
                  <TableCell className="font-mono text-xs">{r.perms}</TableCell>
                  <TableCell className="text-right">{formatBytes(r.rss)}</TableCell>
                  <TableCell className="text-right">{formatBytes(r.pss)}</TableCell>
                  <TableCell className="text-right">{formatBytes(r.size)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onPeek(r)}
                      disabled={peekingStart === r.start || r.rss === 0}
                    >
                      {peekingStart === r.start ? (
                        <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <IconEye className="h-3.5 w-3.5" />
                      )}
                      Peek
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {inspectPeek && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm font-semibold">
                {inspectPeek.address} · {formatBytes(inspectPeek.bytesRead)} read
                {inspectPeek.truncated && " (strings truncated)"}
              </div>
              {inspectPeek.error && (
                <span className="text-xs text-destructive">{inspectPeek.error}</span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {inspectPeek.strings.length} strings (min length 8). Hex preview of first 256 bytes:
            </div>
            <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
              {inspectPeek.hexPreview.match(/.{1,32}/g)?.join("\n") ?? ""}
            </pre>
            {inspectPeek.strings.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No printable ASCII strings of length ≥ 8 found. This region is
                likely binary data (V8 internal state, compressed pages,
                compiled code, etc.).
              </p>
            ) : (
              <div className="max-h-96 overflow-auto rounded bg-muted p-2">
                <table className="w-full text-xs">
                  <tbody>
                    {inspectPeek.strings.map((s, i) => (
                      <tr key={i} className="align-top">
                        <td className="pr-3 font-mono text-muted-foreground">
                          +{s.offset.toString(16)}
                        </td>
                        <td className="break-all font-mono">{s.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
