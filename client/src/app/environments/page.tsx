import { EnvironmentList } from "@/components/environments";
import { IconServer } from "@tabler/icons-react";

export function EnvironmentsPage() {

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-md bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
            <IconServer className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Environments</h1>
            <p className="text-muted-foreground">
              Manage your service environments and networks
            </p>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-full">
        <div className="space-y-6">
          <EnvironmentList />

        </div>
      </div>
    </div>
  );
}