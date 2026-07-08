import { NavLink, useLocation } from "react-router-dom";
import {
  IconAdjustments,
  IconDatabase,
  IconId,
  IconLayoutDashboard,
  IconRoute,
  IconSettings,
  IconStack2,
  IconTag,
  IconTimeline,
  IconVariable,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { useConfigNav } from "./config-nav";
import { EDIT_SECTIONS, sectionAnchorId } from "./configuration/section-meta";

const TOP_ITEMS = [
  { to: "overview", label: "Overview", icon: IconLayoutDashboard },
  { to: "services", label: "Services", icon: IconStack2 },
  { to: "configuration", label: "Configuration", icon: IconSettings },
  { to: "activity", label: "Activity", icon: IconTimeline },
] as const;

const SECTION_ICONS: Record<string, typeof IconTag> = {
  image: IconTag,
  environment: IconVariable,
  networking: IconRoute,
  storage: IconDatabase,
  runtime: IconAdjustments,
  identity: IconId,
};

const itemBase =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors";

/**
 * Single left-hand navigation for the whole application detail page. The four
 * tabs became rail items; when Configuration is the active route its sections
 * nest underneath, driven by the live state the Configuration form publishes
 * through {@link useConfigNav} (scroll-spy highlight, error dots, badges).
 */
export function PageNav({ basePath }: { basePath: string }) {
  const location = useLocation();
  const { state } = useConfigNav();
  const configActive = location.pathname.endsWith("/configuration");

  const activeSection = state?.activeId ?? EDIT_SECTIONS[0].id;

  const scrollTo = (id: string) => {
    if (state?.onNavigate) {
      state.onNavigate(id);
    } else {
      document
        .getElementById(sectionAnchorId(id))
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <nav
      aria-label="Application sections"
      className="sticky top-4 flex flex-col gap-1 self-start"
    >
      {TOP_ITEMS.map((item) => {
        const Icon = item.icon;
        const showSections = item.to === "configuration" && configActive;
        return (
          <div key={item.to}>
            <NavLink
              to={`${basePath}/${item.to}`}
              end
              className={({ isActive }) =>
                cn(
                  itemBase,
                  isActive
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
            </NavLink>

            {showSections && (
              <div className="border-border my-1 ml-4 flex flex-col gap-0.5 border-l pl-2.5">
                {EDIT_SECTIONS.map((section) => {
                  const Sub = SECTION_ICONS[section.id] ?? IconAdjustments;
                  const isActive = section.id === activeSection;
                  const hasError = state?.erroredIds.has(section.id) ?? false;
                  const badge = state?.badges[section.id];
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => scrollTo(section.id)}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        itemBase,
                        "py-1 text-[13px]",
                        isActive
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Sub className="h-4 w-4 shrink-0" />
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
            )}
          </div>
        );
      })}
    </nav>
  );
}
