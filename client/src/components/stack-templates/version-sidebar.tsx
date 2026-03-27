import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { StackTemplateInfo, StackTemplateVersionInfo } from "@mini-infra/types";

interface VersionSidebarProps {
  template: StackTemplateInfo;
  versions: StackTemplateVersionInfo[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
}

export function VersionSidebar({
  template,
  versions,
  selectedVersionId,
  onSelectVersion,
}: VersionSidebarProps) {
  const draftVersion = versions.find((v) => v.status === "draft");
  const publishedVersions = versions
    .filter((v) => v.status === "published")
    .sort((a, b) => b.version - a.version);
  const archivedVersions = versions
    .filter((v) => v.status === "archived")
    .sort((a, b) => b.version - a.version);

  // null selectedVersionId means the draft is selected
  const isDraftSelected = selectedVersionId === null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Version History
        </span>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-2 pb-4 space-y-1">
          {/* Draft entry */}
          {draftVersion && (
            <button
              onClick={() => onSelectVersion(null)}
              className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent ${
                isDraftSelected
                  ? "border-orange-500 bg-orange-50 dark:bg-orange-950/20"
                  : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-medium">Draft</span>
                <Badge className="bg-orange-500 text-white text-xs">editing</Badge>
              </div>
              {draftVersion.createdAt && (
                <div className="text-xs text-muted-foreground">
                  Modified {format(new Date(draftVersion.createdAt), "MMM d, yyyy")}
                </div>
              )}
            </button>
          )}

          {/* Published versions */}
          {publishedVersions.map((version) => {
            const isCurrent = version.id === template.currentVersionId;
            const isSelected = selectedVersionId === version.id;
            return (
              <button
                key={version.id}
                onClick={() => onSelectVersion(version.id)}
                className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent ${
                  isSelected
                    ? isCurrent
                      ? "border-green-500 bg-green-50 dark:bg-green-950/20"
                      : "border-primary bg-accent"
                    : isCurrent
                      ? "border-green-500/50"
                      : "border-border"
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium">v{version.version}</span>
                  {isCurrent ? (
                    <Badge className="bg-green-500 text-white text-xs">current</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">
                      archived
                    </Badge>
                  )}
                </div>
                {version.notes && (
                  <div className="text-xs text-muted-foreground truncate">{version.notes}</div>
                )}
                {version.publishedAt && (
                  <div className="text-xs text-muted-foreground">
                    Published {format(new Date(version.publishedAt), "MMM d, yyyy")}
                  </div>
                )}
              </button>
            );
          })}

          {/* Archived versions */}
          {archivedVersions.length > 0 && (
            <details>
              <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground hover:text-foreground select-none">
                {archivedVersions.length} archived version
                {archivedVersions.length !== 1 ? "s" : ""}
              </summary>
              <div className="space-y-1 mt-1">
                {archivedVersions.map((version) => {
                  const isSelected = selectedVersionId === version.id;
                  return (
                    <button
                      key={version.id}
                      onClick={() => onSelectVersion(version.id)}
                      className={`w-full text-left rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent ${
                        isSelected ? "border-primary bg-accent" : "border-border"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium">v{version.version}</span>
                        <Badge variant="outline" className="text-xs">
                          archived
                        </Badge>
                      </div>
                      {version.notes && (
                        <div className="text-xs text-muted-foreground truncate">
                          {version.notes}
                        </div>
                      )}
                      {version.publishedAt && (
                        <div className="text-xs text-muted-foreground">
                          Published {format(new Date(version.publishedAt), "MMM d, yyyy")}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
