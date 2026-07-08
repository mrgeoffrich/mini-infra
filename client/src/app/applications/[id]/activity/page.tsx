import { useOutletContext } from "react-router-dom";
import { MonitoringSection } from "../_components/monitoring-section";
import { HistorySection } from "../_components/history-section";
import type { ApplicationDetailContext } from "../layout";

export default function ApplicationActivityTab() {
  const { primaryStack, containerStatus } =
    useOutletContext<ApplicationDetailContext>();

  return (
    <div className="grid gap-6">
      <MonitoringSection
        primaryStack={primaryStack}
        containerStatus={containerStatus}
      />
      <HistorySection primaryStack={primaryStack} />
    </div>
  );
}
