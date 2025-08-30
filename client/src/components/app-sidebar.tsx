import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import {
  IconBrandDocker,
  IconCloud,
  IconCloudComputing,
  IconDashboard,
  IconDatabase,
  IconFileText,
  IconHelp,
  IconInnerShadowTop,
  IconRocket,
  IconSearch,
  IconSettings,
  IconViewfinder,
} from "@tabler/icons-react";

import { NavMain } from "@/components/nav-main";
import { NavSecondary } from "@/components/nav-secondary";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";

const data = {
  navMain: [
    {
      title: "Dashboard",
      url: "/dashboard",
      icon: IconDashboard,
    },
    {
      title: "Containers",
      url: "/containers",
      icon: IconBrandDocker,
    },
    {
      title: "Databases",
      url: "/databases",
      icon: IconDatabase,
    },
    {
      title: "Deployments",
      url: "/deployments",
      icon: IconRocket,
    },
    {
      title: "Cloudflare Tunnels",
      url: "/tunnels",
      icon: IconCloud,
    },
  ],
  navSecondary: [
    {
      title: "Activity Logs",
      url: "/logs",
      icon: IconFileText,
    },
    {
      title: "Help",
      url: "#",
      icon: IconHelp,
    },
    {
      title: "Search",
      url: "#",
      icon: IconSearch,
    },
  ],
  settingsNav: [
    {
      title: "Overview",
      url: "/settings/overview",
      icon: IconViewfinder,
    },
    {
      title: "Docker Configuration",
      url: "/settings/docker",
      icon: IconBrandDocker,
    },
    {
      title: "Cloudflare Settings",
      url: "/settings/cloudflare",
      icon: IconCloudComputing,
    },
    {
      title: "Azure Storage",
      url: "/settings/azure",
      icon: IconCloud,
    },
  ],
};

function NavSettings() {
  const location = useLocation();
  const isSettingsActive = location.pathname.startsWith("/settings");

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isSettingsActive}>
              <Link to="/settings">
                <IconSettings />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
            {isSettingsActive && (
              <SidebarMenuSub>
                {data.settingsNav.map((item) => (
                  <SidebarMenuSubItem key={item.title}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={location.pathname === item.url}
                    >
                      <Link to={item.url}>
                        <item.icon />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
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
        <NavMain items={data.navMain} />
        <NavSettings />
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
