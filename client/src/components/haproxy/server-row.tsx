import { useState } from "react";
import {
  IconDots,
  IconEdit,
  IconBrandDocker,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import { HAProxyServerInfo } from "@mini-infra/types";
import { EditServerDialog } from "./edit-server-dialog";

interface ServerRowProps {
  server: HAProxyServerInfo;
  backendName: string;
  environmentId: string;
}

function ServerStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge
          variant="outline"
          className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
        >
          Active
        </Badge>
      );
    case "draining":
      return (
        <Badge
          variant="outline"
          className="text-yellow-700 border-yellow-200 bg-yellow-50 dark:text-yellow-300 dark:border-yellow-800 dark:bg-yellow-950"
        >
          Draining
        </Badge>
      );
    case "removed":
      return (
        <Badge
          variant="outline"
          className="text-gray-700 border-gray-200 bg-gray-50 dark:text-gray-300 dark:border-gray-800 dark:bg-gray-950"
        >
          Removed
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function ServerRow({ server, backendName, environmentId }: ServerRowProps) {
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const healthCheckSummary = server.checkPath
    ? `${server.checkPath}${server.inter ? `, ${server.inter}ms interval` : ""}`
    : "None";

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="font-medium font-mono text-sm">{server.name}</div>
          {server.containerName && (
            <div className="flex items-center gap-1 mt-0.5">
              <IconBrandDocker className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {server.containerName}
                {server.containerId && (
                  <span className="ml-1 font-mono">
                    ({server.containerId.substring(0, 12)})
                  </span>
                )}
              </span>
            </div>
          )}
        </TableCell>
        <TableCell>
          <span className="font-mono text-sm">
            {server.address}:{server.port}
          </span>
        </TableCell>
        <TableCell>
          <span className="text-sm">{server.weight}</span>
        </TableCell>
        <TableCell>
          <span className="text-sm text-muted-foreground">{healthCheckSummary}</span>
        </TableCell>
        <TableCell>
          <ServerStatusBadge status={server.status} />
        </TableCell>
        <TableCell>
          {server.maintenance ? (
            <Badge
              variant="outline"
              className="text-red-700 border-red-200 bg-red-50 dark:text-red-300 dark:border-red-800 dark:bg-red-950"
            >
              On
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
            >
              Off
            </Badge>
          )}
        </TableCell>
        <TableCell>
          {server.enabled ? (
            <Badge
              variant="outline"
              className="text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-800 dark:bg-green-950"
            >
              Yes
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-gray-700 border-gray-200 bg-gray-50 dark:text-gray-300 dark:border-gray-800 dark:bg-gray-950"
            >
              No
            </Badge>
          )}
        </TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <IconDots className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditDialogOpen(true)}>
                <IconEdit className="h-4 w-4 mr-2" />
                Edit Server
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>

      <EditServerDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        server={server}
        backendName={backendName}
        environmentId={environmentId}
      />
    </>
  );
}
