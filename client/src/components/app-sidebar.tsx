import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import { IconInnerShadowTop, IconPalette, IconDashboard, IconBook, IconArrowLeft } from "@tabler/icons-react";

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
import { getNavigationSections } from "@/lib/route-config";
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

// Standard app sidebar content - shown on all non-help routes
function AppSidebarContent() {
  const navSections = getNavigationSections();
  const location = useLocation();

  return (
    <>
      {/* Dashboard - standalone at top */}
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

      {/* Render each navigation section */}
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

      {/* Push dev section to bottom */}
      <div className="mt-auto">
        {/* Development-only Design Tools section */}
        {import.meta.env.DEV && (
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
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </div>
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
      <SidebarContent>
        {isHelpRoute ? <HelpSidebarContent /> : <AppSidebarContent />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
