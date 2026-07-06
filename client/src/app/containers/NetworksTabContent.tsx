import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconListDetails, IconNetwork } from "@tabler/icons-react";
import { ManagedNetworksList } from "./ManagedNetworksList";
import { NetworksList } from "./NetworksList";

type NetworksSubTab = "managed" | "all";

/**
 * Network overhaul Phase 9 — the "Networks" tab's content, split into two
 * sub-views: the new managed-network view (owner/purpose/status/members —
 * `ManagedNetworksList`, default) and the pre-existing raw Docker network
 * list+delete (`NetworksList`, unchanged — kept per the plan's non-goal of
 * removing it).
 */
export function NetworksTabContent() {
  const [subTab, setSubTab] = useState<NetworksSubTab>("managed");

  return (
    <Tabs
      value={subTab}
      onValueChange={(value) => setSubTab(value as NetworksSubTab)}
      className="w-full"
      data-tour="networks-sub-tabs"
    >
      <TabsList>
        <TabsTrigger value="managed" className="gap-2">
          <IconNetwork className="h-4 w-4" />
          Managed Networks
        </TabsTrigger>
        <TabsTrigger value="all" className="gap-2">
          <IconListDetails className="h-4 w-4" />
          All Networks
        </TabsTrigger>
      </TabsList>

      <TabsContent value="managed" className="pt-4">
        <ManagedNetworksList />
      </TabsContent>

      <TabsContent value="all" className="pt-4">
        <NetworksList />
      </TabsContent>
    </Tabs>
  );
}
