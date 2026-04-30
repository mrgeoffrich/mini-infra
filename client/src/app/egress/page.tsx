/**
 * Egress overview page mounted at /egress.
 *
 * Stack-centric IA: a flat list of every stack with an egress policy. Per-env
 * firewall enable toggles and the host-singleton firewall agent status live in
 * a collapsible strip at the top so they're available without dominating the
 * view. Click a stack row to drill into its rules + scoped traffic feed.
 */

import { IconShield } from "@tabler/icons-react";
import { EgressEnvironmentsStrip } from "@/components/egress/egress-environments-strip";
import { EgressStacksTable } from "@/components/egress/egress-stacks-table";

export default function EgressPage() {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
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
      </div>

      <div className="px-4 lg:px-6 max-w-7xl space-y-6">
        <EgressEnvironmentsStrip />
        <EgressStacksTable />
      </div>
    </div>
  );
}
