import { HostTemplatesList } from "@/components/host/host-templates-list";
import { IconServer } from "@tabler/icons-react";

export function HostPage() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
          <IconServer className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Host</h1>
          <p className="text-sm text-muted-foreground">
            Host-level infrastructure templates and their deployments
          </p>
        </div>
      </div>

      <HostTemplatesList />
    </div>
  );
}
