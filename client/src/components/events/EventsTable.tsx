import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
} from "@tanstack/react-table";
import { useDataTable } from "@/lib/react-table";
import {
  IconClock,
  IconEye,
  IconTrash,
  IconDotsVertical,
} from "@tabler/icons-react";
import { formatDistanceToNow } from "date-fns";

import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EventStatusBadge } from "./EventStatusBadge";
import { EventTypeBadge } from "./EventTypeBadge";
import { Progress } from "@/components/ui/progress";
import { UserEventInfo } from "@mini-infra/types";

interface EventsTableProps {
  events: UserEventInfo[];
  isLoading?: boolean;
  onDeleteEvent?: (eventId: string) => void;
}

export function EventsTable({ events, isLoading, onDeleteEvent }: EventsTableProps) {
  const navigate = useNavigate();
  const { formatDateTime } = useFormattedDate();

  const columns = useMemo<ColumnDef<UserEventInfo>[]>(
    () => [
      {
        id: "eventName",
        accessorKey: "eventName",
        header: "Event Name",
        cell: ({ row }) => {
          const event = row.original;
          return (
            <div className="flex flex-col gap-1">
              <div className="font-medium">{event.eventName}</div>
              {event.description && (
                <div className="text-sm text-muted-foreground line-clamp-1">
                  {event.description}
                </div>
              )}
              {event.resourceName && (
                <div className="text-xs text-muted-foreground">
                  Resource: {event.resourceName}
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "type",
        accessorKey: "eventType",
        header: "Type",
        cell: ({ row }) => (
          <EventTypeBadge
            eventType={row.original.eventType}
            eventCategory={row.original.eventCategory}
          />
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => {
          const event = row.original;
          return (
            <div className="flex flex-col gap-2">
              <EventStatusBadge status={event.status} />
              {(event.status === "running" || event.status === "pending") && (
                <Progress value={event.progress} className="w-24 h-2" />
              )}
            </div>
          );
        },
      },
      {
        id: "startedAt",
        accessorKey: "startedAt",
        header: "Started",
        cell: ({ row }) => {
          const startedAt = new Date(row.original.startedAt);
          return (
            <div className="flex flex-col gap-1">
              <div className="text-sm">{formatDateTime(row.original.startedAt)}</div>
              <div className="text-xs text-muted-foreground">
                {formatDistanceToNow(startedAt, { addSuffix: true })}
              </div>
            </div>
          );
        },
      },
      {
        id: "duration",
        header: "Duration",
        cell: ({ row }) => {
          const event = row.original;
          if (event.durationMs) {
            const seconds = Math.floor(event.durationMs / 1000);
            if (seconds < 60) {
              return <span>{seconds}s</span>;
            } else if (seconds < 3600) {
              const minutes = Math.floor(seconds / 60);
              const remainingSeconds = seconds % 60;
              return <span>{minutes}m {remainingSeconds}s</span>;
            } else {
              const hours = Math.floor(seconds / 3600);
              const minutes = Math.floor((seconds % 3600) / 60);
              return <span>{hours}h {minutes}m</span>;
            }
          } else if (event.status === "running" || event.status === "pending") {
            return (
              <div className="flex items-center gap-1 text-muted-foreground">
                <IconClock className="h-4 w-4 animate-pulse" />
                <span className="text-sm">In progress</span>
              </div>
            );
          } else {
            return <span className="text-muted-foreground">-</span>;
          }
        },
      },
      {
        id: "triggeredBy",
        accessorKey: "triggeredBy",
        header: "Triggered By",
        cell: ({ row }) => {
          const event = row.original;
          return (
            <div className="flex flex-col gap-1">
              <div className="capitalize text-sm">{event.triggeredBy}</div>
              {event.user && (
                <div className="text-xs text-muted-foreground">
                  {event.user.name || event.user.email}
                </div>
              )}
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const event = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <IconDotsVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => navigate(`/events/${event.id}`)}
                >
                  <IconEye className="h-4 w-4 mr-2" />
                  View Details
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDeleteEvent?.(event.id)}
                  className="text-destructive focus:text-destructive"
                >
                  <IconTrash className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [navigate, formatDateTime, onDeleteEvent],
  );

  const table = useDataTable({
    data: events,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="text-center py-12 border rounded-lg">
        <p className="text-muted-foreground">No events found</p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer"
              onClick={() => navigate(`/events/${row.original.id}`)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  onClick={(e) => {
                    // Prevent navigation when clicking on dropdown menu
                    if (cell.column.id === "actions") {
                      e.stopPropagation();
                    }
                  }}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
