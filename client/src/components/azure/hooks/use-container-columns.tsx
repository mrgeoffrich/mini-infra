import React from "react";
import { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AzureContainerInfo } from "@mini-infra/types";
import { ContainerAccessTest } from "../constants";
import {
  ContainerNameCell,
  LastModifiedCell,
  LeaseStatusCell,
  PublicAccessCell,
  MetadataCell,
  ActionsCell,
} from "../cells";

interface UseContainerColumnsOptions {
  onNameSort: () => void;
  onLastModifiedSort: () => void;
  onLeaseStatusSort: () => void;
  onTestAccess: (containerName: string) => void;
  containerTests: Map<string, ContainerAccessTest>;
}

export function useContainerColumns({
  onNameSort,
  onLastModifiedSort,
  onLeaseStatusSort,
  onTestAccess,
  containerTests,
}: UseContainerColumnsOptions): ColumnDef<AzureContainerInfo>[] {
  return React.useMemo(
    () => [
      {
        accessorKey: "name",
        header: () => (
          <Button
            variant="ghost"
            onClick={onNameSort}
            className="h-auto p-0 font-medium"
          >
            Container Name
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => <ContainerNameCell name={row.getValue("name")} />,
      },
      {
        accessorKey: "lastModified",
        header: () => (
          <Button
            variant="ghost"
            onClick={onLastModifiedSort}
            className="h-auto p-0 font-medium"
          >
            Last Modified
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <LastModifiedCell lastModified={row.getValue("lastModified")} />
        ),
      },
      {
        accessorKey: "leaseStatus",
        header: () => (
          <Button
            variant="ghost"
            onClick={onLeaseStatusSort}
            className="h-auto p-0 font-medium"
          >
            Lease Status
            <ArrowUpDown className="ml-2 h-4 w-4" />
          </Button>
        ),
        cell: ({ row }) => (
          <LeaseStatusCell leaseStatus={row.getValue("leaseStatus")} />
        ),
      },
      {
        accessorKey: "publicAccess",
        header: "Access Level",
        cell: ({ row }) => (
          <PublicAccessCell publicAccess={row.getValue("publicAccess")} />
        ),
      },
      {
        accessorKey: "metadata",
        header: "Metadata",
        cell: ({ row }) => <MetadataCell metadata={row.getValue("metadata")} />,
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <ActionsCell
            containerName={row.original.name}
            testStatus={containerTests.get(row.original.name)}
            onTestAccess={onTestAccess}
          />
        ),
      },
    ],
    [
      onNameSort,
      onLastModifiedSort,
      onLeaseStatusSort,
      onTestAccess,
      containerTests,
    ],
  );
}
