/**
 * Egress overview page mounted at /egress.
 *
 * Stack-centric IA: a flat list of every stack with an egress policy. Per-env
 * firewall enable toggles sit in the page header's top-right; the host-singleton
 * firewall agent has its own page at /settings-egress-fw-agent.
 */

import { IconShield } from "@tabler/icons-react";
import { EgressEnvironmentFirewallToggles } from "@/components/egress/egress-environment-firewall-toggles";
import { EgressStacksTable } from "@/components/egress/egress-stacks-table";

export default function EgressPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
              <IconShield className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Egress</h1>
              <p className="text-muted-foreground">
                Outbound traffic control across all stacks
              </p>
            </div>
          </div>
          <EgressEnvironmentFirewallToggles />
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-6">
        <EgressStacksTable />
      </div>
    </div>
  );
}
