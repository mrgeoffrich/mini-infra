import { useLocation } from "react-router-dom";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";

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
      return "Settings";
    default:
      return "Dashboard";
  }
};

export function SiteHeader() {
  const location = useLocation();
  const pageTitle = getPageTitle(location.pathname);

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <h1 className="text-base font-medium">{pageTitle}</h1>
      </div>
    </header>
  );
}
