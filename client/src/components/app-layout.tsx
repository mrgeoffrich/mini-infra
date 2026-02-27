import { Outlet } from "react-router-dom";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AgentChatProvider } from "@/components/agent/agent-chat-provider";
import { AgentChatFAB } from "@/components/agent/agent-chat-fab";
import { AgentChatSheet } from "@/components/agent/agent-chat-sheet";

export function AppLayout() {
  return (
    <AgentChatProvider>
      <SidebarProvider
        style={
          {
            "--sidebar-width": "calc(var(--spacing) * 72)",
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        <AppSidebar variant="inset" />
        <SidebarInset>
          <SiteHeader />
          <div className="flex flex-1 flex-col">
            <div className="@container/main flex flex-1 flex-col gap-2">
              <Outlet />
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
      <AgentChatFAB />
      <AgentChatSheet />
    </AgentChatProvider>
  );
}
