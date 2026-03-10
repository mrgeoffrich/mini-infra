import { useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  IconCertificate,
  IconDotsVertical,
  IconTrash,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { useFormattedDate } from "@/hooks/use-formatted-date";
import { useRevokeCertificate } from "@/hooks/use-certificates";
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
} from "@tanstack/react-table";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CertificateStatusBadge } from "./certificate-status-badge";
import { cn } from "@/lib/utils";
import type { TlsCertificate } from "@mini-infra/types";

function RevokeCertificateDialog({
  certificate,
  open,
  onOpenChange,
}: {
  certificate: TlsCertificate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { mutate: revoke, isPending } = useRevokeCertificate(certificate?.id ?? "");

  const handleConfirm = () => {
    revoke(undefined, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <IconAlertTriangle className="h-5 w-5 text-destructive" />
            <AlertDialogTitle>Revoke Certificate</AlertDialogTitle>
          </div>
          <AlertDialogDescription>
            Are you sure you want to revoke the certificate for{" "}
            <strong>{certificate?.primaryDomain}</strong>? This action cannot be
            undone. The certificate will be permanently deleted and any services
            using it will need a new certificate.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? (
              <>
                <IconTrash className="h-4 w-4 mr-2 animate-spin" />
                Revoking...
              </>
            ) : (
              <>
                <IconTrash className="h-4 w-4 mr-2" />
                Revoke
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface CertificateListProps {
  certificates: TlsCertificate[];
}

export function CertificateList({ certificates }: CertificateListProps) {
  const navigate = useNavigate();
  const { formatDateTime } = useFormattedDate();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [certificateToRevoke, setCertificateToRevoke] = useState<TlsCertificate | null>(null);

  const handleRevokeClick = useCallback((cert: TlsCertificate) => {
    setCertificateToRevoke(cert);
    setRevokeDialogOpen(true);
  }, []);

  const columns = useMemo<ColumnDef<TlsCertificate>[]>(
    () => [
      {
        accessorKey: "primaryDomain",
        header: "Domain",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <IconCertificate className="h-4 w-4 text-muted-foreground" />
            <div>
              <div className="font-medium">{row.original.primaryDomain}</div>
              {row.original.domains.length > 1 && (
                <div className="text-xs text-muted-foreground">
                  +{row.original.domains.length - 1} more
                </div>
              )}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <CertificateStatusBadge status={row.original.status} />
        ),
      },
      {
        accessorKey: "notAfter",
        header: "Expires",
        cell: ({ row }) => {
          const daysUntilExpiry = Math.floor(
            (new Date(row.original.notAfter).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24)
          );
          return (
            <div>
              <div className="text-sm">{formatDateTime(row.original.notAfter)}</div>
              <div
                className={cn(
                  "text-xs",
                  daysUntilExpiry <= 7
                    ? "text-red-600"
                    : daysUntilExpiry <= 14
                      ? "text-orange-600"
                      : "text-muted-foreground"
                )}
              >
                {daysUntilExpiry} days remaining
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "autoRenew",
        header: "Auto-Renew",
        cell: ({ row }) => (
          <Badge variant={row.original.autoRenew ? "default" : "secondary"}>
            {row.original.autoRenew ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <IconDotsVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/certificates/${row.original.id}`);
                }}
              >
                <IconCertificate className="h-4 w-4 mr-2" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleRevokeClick(row.original);
                }}
                className="text-destructive focus:text-destructive"
              >
                <IconTrash className="h-4 w-4 mr-2" />
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [formatDateTime, navigate, handleRevokeClick]
  );

  const table = useReactTable({
    data: certificates,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
  });

  return (
    <>
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
                      header.getContext()
                    )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows?.length ? (
          table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => navigate(`/certificates/${row.original.id}`)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow>
            <TableCell colSpan={columns.length} className="h-24 text-center">
              No certificates found
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    <RevokeCertificateDialog
      certificate={certificateToRevoke}
      open={revokeDialogOpen}
      onOpenChange={setRevokeDialogOpen}
    />
    </>
  );
}
