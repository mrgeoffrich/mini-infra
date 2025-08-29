import { Link, useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const getPageTitle = (pathname: string): string => {
  switch (pathname) {
    case "/dashboard":
      return "Dashboard";
    case "/containers":
      return "Containers";
    case "/databases":
      return "Databases";
    case "/deployments":
      return "Deployments";
    case "/tunnels":
      return "Cloudflare Tunnels";
    case "/logs":
      return "Activity Logs";
    case "/settings":
    case "/settings/overview":
      return "Settings";
    case "/settings/docker":
      return "Docker Configuration";
    case "/settings/cloudflare":
      return "Cloudflare Settings";
    case "/settings/azure":
      return "Azure Storage";
    case "/settings/audit":
      return "Audit History";
    default:
      return "Dashboard";
  }
};

const getSettingsPageTitle = (pathname: string): string => {
  switch (pathname) {
    case "/settings/overview":
      return "Overview";
    case "/settings/docker":
      return "Docker Configuration";
    case "/settings/cloudflare":
      return "Cloudflare Settings";
    case "/settings/azure":
      return "Azure Storage";
    case "/settings/audit":
      return "Audit History";
    default:
      return "Settings";
  }
};

export function SiteHeader() {
  const location = useLocation();
  const pageTitle = getPageTitle(location.pathname);
  const isSettingsPage =
    location.pathname.startsWith("/settings") &&
    location.pathname !== "/settings";

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        {isSettingsPage ? (
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/settings">Settings</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {getSettingsPageTitle(location.pathname)}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        ) : (
          <h1 className="text-base font-medium">{pageTitle}</h1>
        )}
      </div>
    </header>
  );
}
