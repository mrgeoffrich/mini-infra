import {
  IconAdjustments,
  IconDatabase,
  IconId,
  IconRoute,
  IconTag,
  IconVariable,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
  EDIT_SECTIONS,
  SECTION_GROUP_LABELS,
  type SectionDescriptor,
  type SectionGroup,
} from "./section-meta";

const SECTION_ICONS: Record<string, typeof IconTag> = {
  image: IconTag,
  environment: IconVariable,
  networking: IconRoute,
  storage: IconDatabase,
  runtime: IconAdjustments,
  identity: IconId,
};

interface SectionRailProps {
  sections?: SectionDescriptor[];
  activeId: string;
  erroredIds: Set<string>;
  badges: Record<string, number | undefined>;
  onNavigate: (id: string) => void;
}

export function SectionRail({
  sections = EDIT_SECTIONS,
  activeId,
  erroredIds,
  badges,
  onNavigate,
}: SectionRailProps) {
  const groups = sections.reduce<Record<SectionGroup, SectionDescriptor[]>>(
    (acc, section) => {
      (acc[section.group] ??= []).push(section);
      return acc;
    },
    {} as Record<SectionGroup, SectionDescriptor[]>,
  );
  const groupOrder: SectionGroup[] = ["frequent", "network", "once"];

  return (
    <nav
      aria-label="Configuration sections"
      className="sticky top-20 hidden flex-col gap-1 self-start text-sm md:flex"
    >
      {groupOrder.map((group) =>
        groups[group]?.length ? (
          <div key={group} className="mb-1">
            <p className="text-muted-foreground px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide uppercase">
              {SECTION_GROUP_LABELS[group]}
            </p>
            {groups[group].map((section) => {
              const Icon = SECTION_ICONS[section.id] ?? IconAdjustments;
              const isActive = section.id === activeId;
              const hasError = erroredIds.has(section.id);
              const badge = badges[section.id];
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => onNavigate(section.id)}
                  aria-current={isActive ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{section.label}</span>
                  {hasError && (
                    <span
                      className="bg-destructive h-1.5 w-1.5 shrink-0 rounded-full"
                      aria-label="has errors"
                    />
                  )}
                  {typeof badge === "number" && badge > 0 && (
                    <span className="bg-muted text-muted-foreground rounded-full px-1.5 text-[11px]">
                      {badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : null,
      )}
    </nav>
  );
}
