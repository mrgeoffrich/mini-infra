import * as React from "react";
import { Link } from "react-router-dom";
import {
  IconBrandDocker,
  IconCloud,
  IconCloudComputing,
  IconDashboard,
  IconDatabase,
  IconInnerShadowTop,
  IconKey,
  IconRocket,
  IconSettings,
} from "@tabler/icons-react";

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
      title: "PostgreSQL",
      url: "/postgres",
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
    {
      title: "API Keys",
      url: "/api-keys",
      icon: IconKey,
    },
    {
      title: "Connectivity",
      url: "/connectivity",
      icon: IconSettings,
      items: [
        {
          title: "Docker Configuration",
          url: "/connectivity/docker",
          icon: IconBrandDocker,
        },
        {
          title: "Cloudflare Settings",
          url: "/connectivity/cloudflare",
          icon: IconCloudComputing,
        },
        {
          title: "Azure Storage",
          url: "/connectivity/azure",
          icon: IconCloud,
        },
      ],
    },
  ],
  navSecondary: [
    {
      title: "System Settings",
      url: "/settings/system",
      icon: IconSettings,
    },
  ],
};

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
        <NavSecondary items={data.navSecondary} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
