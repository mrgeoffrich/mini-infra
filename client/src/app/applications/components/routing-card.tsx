import { useFormContext } from "react-hook-form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import type { ApplicationRoutingData } from "@/lib/application-schemas";
import { RoutingSection } from "./routing-section";

interface Props {
  networkType?: "local" | "internet";
  detectedPorts?: number[];
  showEnableToggle?: boolean;
}

/**
 * Routing card used by the create wizard. Wraps the shared `RoutingSection`
 * with card chrome and an optional enable toggle. The edit page renders
 * `RoutingSection` directly inside its Networking section instead.
 */
export function RoutingCard({
  networkType,
  detectedPorts = [],
  showEnableToggle = false,
}: Props) {
  const form = useFormContext<ApplicationRoutingData>();
  const enableRouting = form.watch("enableRouting");
  const showRoutingFields = !showEnableToggle || enableRouting;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {showEnableToggle && (
          <FormField
            control={form.control}
            name="enableRouting"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3">
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel className="!mt-0">Enable routing</FormLabel>
              </FormItem>
            )}
          />
        )}

        {showRoutingFields && (
          <RoutingSection
            networkType={networkType}
            detectedPorts={detectedPorts}
          />
        )}
      </CardContent>
    </Card>
  );
}
