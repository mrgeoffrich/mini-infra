import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EnvVarsSection,
  VolumesSection,
  PortsSection,
  HealthCheckSection,
  RestartPolicySection,
} from "./config-sections";

/**
 * Tabbed configuration card used by the create wizard. The application edit
 * page composes the same underlying sections into its settings-rail layout
 * instead of these tabs — both share the field-group bodies in
 * `config-sections.tsx`.
 */
export function ConfigurationCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="env" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="env">Env vars</TabsTrigger>
            <TabsTrigger value="volumes">Volumes</TabsTrigger>
            <TabsTrigger value="health">Health check</TabsTrigger>
            <TabsTrigger value="ports">Ports</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          <TabsContent value="env" className="mt-4">
            <EnvVarsSection />
          </TabsContent>

          <TabsContent value="volumes" className="mt-4">
            <VolumesSection />
          </TabsContent>

          <TabsContent value="health" className="mt-4">
            <HealthCheckSection />
          </TabsContent>

          <TabsContent value="ports" className="mt-4">
            <PortsSection />
          </TabsContent>

          <TabsContent value="advanced" className="mt-4">
            <RestartPolicySection />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
