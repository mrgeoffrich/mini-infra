import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  IconTerminal,
  IconSearch,
  IconDownload,
  IconCopy,
  IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";

interface EventLogsViewerProps {
  logs: string | null;
  eventName: string;
}

export function EventLogsViewer({ logs, eventName }: EventLogsViewerProps) {
  const [searchTerm, setSearchTerm] = useState("");

  const logLines = useMemo(() => {
    if (!logs) return [];
    return logs.split("\n").filter((line) => line.trim() !== "");
  }, [logs]);

  const filteredLines = useMemo(() => {
    if (!searchTerm) return logLines;
    const lowerSearch = searchTerm.toLowerCase();
    return logLines.filter((line) =>
      line.toLowerCase().includes(lowerSearch),
    );
  }, [logLines, searchTerm]);

  const handleCopyLogs = async () => {
    if (!logs) return;
    try {
      await navigator.clipboard.writeText(logs);
      toast.success("Logs copied to clipboard");
    } catch (error) {
      toast.error("Failed to copy logs");
    }
  };

  const handleDownloadLogs = () => {
    if (!logs) return;
    const blob = new Blob([logs], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${eventName.replace(/\s+/g, "-").toLowerCase()}-logs.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Logs downloaded");
  };

  const highlightSearchTerm = (text: string) => {
    if (!searchTerm) return text;

    const parts = text.split(new RegExp(`(${searchTerm})`, "gi"));
    return parts.map((part, index) =>
      part.toLowerCase() === searchTerm.toLowerCase() ? (
        <mark key={index} className="bg-yellow-200 dark:bg-yellow-800">
          {part}
        </mark>
      ) : (
        part
      ),
    );
  };

  if (!logs) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <IconTerminal className="h-5 w-5" />
            Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            No logs available for this event
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <IconTerminal className="h-5 w-5" />
            Logs
            {filteredLines.length !== logLines.length && (
              <span className="text-sm font-normal text-muted-foreground">
                ({filteredLines.length} of {logLines.length} lines)
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCopyLogs}>
              <IconCopy className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={handleDownloadLogs}>
              <IconDownload className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search logs..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          {searchTerm && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchTerm("")}
            >
              <IconX className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Logs Container */}
        <div className="bg-black text-green-400 p-4 rounded-md font-mono text-xs overflow-x-auto max-h-[600px] overflow-y-auto">
          {filteredLines.length > 0 ? (
            <div className="space-y-1">
              {filteredLines.map((line, index) => (
                <div key={index} className="flex gap-4">
                  <span className="text-gray-600 select-none w-12 text-right shrink-0">
                    {logLines.indexOf(line) + 1}
                  </span>
                  <span className="whitespace-pre-wrap break-all">
                    {highlightSearchTerm(line)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              No logs match your search
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
