import { RoutingCard } from "../../components/routing-card";

interface Props {
  networkType?: "local" | "internet";
  detectedPorts: number[];
}

export function RoutingStep({ networkType, detectedPorts }: Props) {
  return <RoutingCard networkType={networkType} detectedPorts={detectedPorts} />;
}
