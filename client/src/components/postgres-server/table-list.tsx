import { useState } from "react";
import { IconTable, IconSearch, IconRefresh } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { DatabaseTableInfo } from "@mini-infra/types";

interface TableListProps {
  tables: DatabaseTableInfo[];
  isLoading: boolean;
  selectedTable: string | null;
  onSelectTable: (tableName: string) => void;
  onRefresh?: () => void;
}

export function TableList({
  tables,
  isLoading,
  selectedTable,
  onSelectTable,
  onRefresh,
}: TableListProps) {
  const [searchQuery, setSearchQuery] = useState("");

  // Filter tables based on search query
  const filteredTables = tables.filter((table) =>
    `${table.schema}.${table.name}`.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Format bytes to human-readable size
  const formatBytes = (bytes: number | null): string => {
    if (bytes === null) return "—";
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  // Format row count with commas
  const formatRowCount = (count: number | null): string => {
    if (count === null) return "—";
    return count.toLocaleString();
  };

  // Get badge variant for table type
  const getTableTypeBadge = (type: DatabaseTableInfo["tableType"]) => {
    switch (type) {
      case "BASE TABLE":
        return <Badge variant="default">Table</Badge>;
      case "VIEW":
        return <Badge variant="secondary">View</Badge>;
      case "MATERIALIZED VIEW":
        return <Badge variant="outline">Mat. View</Badge>;
      case "FOREIGN TABLE":
        return <Badge variant="outline">Foreign</Badge>;
      default:
        return <Badge variant="outline">{type}</Badge>;
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="p-4 border-b">
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-2">
          {[...Array(10)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search and Actions */}
      <div className="p-4 border-b space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <IconSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tables..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          {onRefresh && (
            <Button variant="outline" size="icon" onClick={onRefresh}>
              <IconRefresh className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {filteredTables.length} {filteredTables.length === 1 ? "table" : "tables"}
        </div>
      </div>

      {/* Tables List */}
      <div className="flex-1 overflow-auto p-4 space-y-2">
        {filteredTables.length === 0 ? (
          <div className="text-center py-8">
            <IconTable className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
            <p className="text-muted-foreground">
              {searchQuery ? "No tables match your search" : "No tables found"}
            </p>
          </div>
        ) : (
          filteredTables.map((table) => {
            const fullTableName = `${table.schema}.${table.name}`;
            const isSelected = selectedTable === fullTableName;

            return (
              <Card
                key={fullTableName}
                className={`p-4 cursor-pointer transition-colors hover:bg-accent ${
                  isSelected ? "border-primary bg-accent" : ""
                }`}
                onClick={() => onSelectTable(fullTableName)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <IconTable className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <div>
                      <div className="font-medium">{table.name}</div>
                      {table.schema !== "public" && (
                        <div className="text-xs text-muted-foreground">{table.schema}</div>
                      )}
                    </div>
                  </div>
                  {getTableTypeBadge(table.tableType)}
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs">Rows</div>
                    <div className="font-mono">{formatRowCount(table.rowCount)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs">Size</div>
                    <div className="font-mono">{formatBytes(table.sizeBytes)}</div>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
