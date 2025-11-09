import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import { IconInnerShadowTop, IconPalette } from "@tabler/icons-react";

import { NavMain } from "@/components/nav-main";
import { NavSecondary } from "@/components/nav-secondary";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from "@/components/ui/sidebar";
import { getNavigationItems } from "@/lib/route-config";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  // Get navigation items from centralized route configuration
  const navMain = getNavigationItems('main');
  const navSecondary = getNavigationItems('secondary');
  const location = useLocation();

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <Link to="/dashboard">
                <IconInnerShadowTop className="!size-5" />
                <span className="text-base font-semibold">Mini Infra</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} />

        {/* Push secondary nav and dev section to bottom */}
        <div className="mt-auto">
          <NavSecondary items={navSecondary} />

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
                        <IconPalette className="h-4 w-4" />
                        <span>Icon Reference</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </div>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
