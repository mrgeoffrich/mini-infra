import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { IconBolt } from "@tabler/icons-react";

interface QuickSetupTabProps {
  serverId: string;
}

export function QuickSetupTab({ serverId: _serverId }: QuickSetupTabProps) {
  return (
    <div className="max-w-3xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              <IconBolt className="h-6 w-6" />
            </div>
            <div>
              <CardTitle>Quick Application Database Setup</CardTitle>
              <CardDescription>
                Create a database, user, and grant full permissions in one step
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-center text-muted-foreground py-6">
            <p className="text-sm">Quick Setup wizard - Coming soon</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
