import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import { IconInnerShadowTop, IconPalette, IconDashboard, IconBook, IconArrowLeft, IconBrandGithub, IconRocket, IconSettings } from "@tabler/icons-react";

import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getNavigationSectionsForPanel, getPanelForPath, type NavPanel } from "@/lib/route-config";
import { useSystemSettings } from "@/hooks/use-settings";
import { getDocsByCategory } from "@/lib/doc-loader";

// Help documentation sidebar content - shown when on /help routes
function HelpSidebarContent() {
  const location = useLocation();
  const categories = getDocsByCategory();

  return (
    <>
      {/* Back to app link */}
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Back to app">
                <Link to="/dashboard">
                  <IconArrowLeft />
                  <span>Back to app</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* All docs link */}
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="All Documentation"
                isActive={location.pathname === "/help"}
              >
                <Link to="/help">
                  <IconBook />
                  <span>All Documentation</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {/* Doc categories and articles */}
      {categories.map((category) => (
        <SidebarGroup key={category.slug}>
          <SidebarGroupLabel className="text-xs text-muted-foreground">
            {category.label}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {category.docs.map((doc) => (
                <SidebarMenuItem key={doc.slug}>
                  <SidebarMenuButton
                    asChild
                    tooltip={doc.frontmatter.title}
                    isActive={location.pathname === doc.href}
                  >
                    <Link to={doc.href}>
                      <span>{doc.frontmatter.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

// Icon rail buttons for switching between Operations and Admin panels
const panelConfig: Array<{ panel: NavPanel; icon: typeof IconRocket; label: string }> = [
  { panel: "operations", icon: IconRocket, label: "Operations" },
  { panel: "admin", icon: IconSettings, label: "Admin" },
];

// Standard app sidebar content - shown on all non-help routes
function AppSidebarContent() {
  const location = useLocation();
  const [activePanel, setActivePanel] = React.useState<NavPanel>(() =>
    getPanelForPath(location.pathname)
  );

  // Auto-switch panel when navigating to a route in a different panel
  React.useEffect(() => {
    const detected = getPanelForPath(location.pathname);
    setActivePanel(detected);
  }, [location.pathname]);

  const navSections = getNavigationSectionsForPanel(activePanel);

  return (
    <>
      {/* Panel Tabs */}
      <div className="flex px-2 pt-2 border-b border-sidebar-border">
        {panelConfig.map(({ panel, icon: PanelIcon, label }) => (
          <button
            key={panel}
            onClick={() => setActivePanel(panel)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium transition-colors -mb-px",
              activePanel === panel
                ? "border border-sidebar-border border-b-transparent rounded-t-md bg-sidebar text-sidebar-accent-foreground"
                : "border border-transparent text-muted-foreground hover:text-sidebar-accent-foreground"
            )}
          >
            <PanelIcon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Dashboard - shown on operations panel */}
      {activePanel === "operations" && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Dashboard"
                    isActive={location.pathname === "/dashboard"}
                  >
                    <Link to="/dashboard">
                      <IconDashboard />
                      <span>Dashboard</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {/* Render navigation sections for active panel */}
        {navSections.map((section) => (
          <SidebarGroup key={section.id}>
            <SidebarGroupLabel className="text-xs text-muted-foreground">
              {section.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => {
                  const isActive = item.items
                    ? location.pathname.startsWith(item.url)
                    : location.pathname === item.url;

                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.title}
                        isActive={isActive}
                      >
                        <Link to={item.url}>
                          {item.icon && <item.icon />}
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                      {item.items && isActive && (
                        <SidebarMenuSub>
                          {item.items.map((subItem) => (
                            <SidebarMenuSubItem key={subItem.title}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={location.pathname === subItem.url}
                              >
                                <Link to={subItem.url}>
                                  {subItem.icon && <subItem.icon />}
                                  <span>{subItem.title}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {/* Development-only section - admin panel only */}
        {activePanel === "admin" && import.meta.env.VITE_SHOW_DEV_MENU === 'true' && (
          <div className="mt-auto">
            <SidebarGroup>
              <SidebarGroupLabel className="text-xs text-muted-foreground">
                Development
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === "/design/icons"}
                    >
                      <Link to="/design/icons">
                        <IconPalette className="size-4" />
                        <span>Icon Reference</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={location.pathname === "/bug-report-settings"}
                    >
                      <Link to="/bug-report-settings">
                        <IconBrandGithub className="size-4" />
                        <span>Bug Report Settings</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </div>
        )}
    </>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const location = useLocation();
  const isHelpRoute = location.pathname.startsWith("/help");

  // Fetch is_production setting
  const { data: settingsData } = useSystemSettings({
    filters: { category: "system", isActive: true },
    limit: 10,
  });

  // Check if production mode is enabled
  const isProduction = React.useMemo(() => {
    const isProductionSetting = settingsData?.data?.find(
      (s) => s.key === "is_production"
    );
    return isProductionSetting?.value === "true";
  }, [settingsData]);

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              {isHelpRoute ? (
                <Link to="/help" className="flex items-center gap-2">
                  <IconBook className="!size-5" />
                  <span className="text-base font-semibold">Documentation</span>
                </Link>
              ) : (
                <Link to="/dashboard" className="flex items-center gap-2">
                  <IconInnerShadowTop className="!size-5" />
                  <span className="text-base font-semibold">Mini Infra</span>
                  {isProduction && (
                    <Badge variant="destructive" className="ml-auto text-xs">
                      PROD
                    </Badge>
                  )}
                </Link>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent data-tour="sidebar-nav">
        {isHelpRoute ? <HelpSidebarContent /> : <AppSidebarContent />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
