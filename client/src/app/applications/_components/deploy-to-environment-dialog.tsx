import { useState } from "react";
import { IconLoader2 } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Channel } from "@mini-infra/types";
import type { StackInfo, StackTemplateInfo } from "@mini-infra/types";
import { useEnvironments } from "@/hooks/use-environments";
import { useDeployApplication } from "@/hooks/use-applications";
import { useTaskTracker } from "@/hooks/use-task-tracker";

/**
 * Deploy an application into an environment the operator chooses.
 *
 * Deploy used to take the environment from the TEMPLATE's `environmentId` and
 * never ask: `handleDeploy` bailed silently if the template had none, and there
 * was no way to deploy the same application into a second environment even though
 * the model has always allowed it (one template → many stacks). The environment
 * was a required argument the user was never given a say in.
 *
 * Environments that already have a deployment of this application are shown but
 * disabled — instantiating a second stack of the same template into one
 * environment collides on the (name, environmentId) uniqueness the server
 * enforces, and "you already have one there" is a better answer than a 409.
 */
export function DeployToEnvironmentDialog({
  template,
  stacks,
  open,
  onOpenChange,
}: {
  template: StackTemplateInfo;
  /** Existing deployments of this application, one per environment. */
  stacks: StackInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: envData } = useEnvironments();
  const deployApplication = useDeployApplication();
  const { registerTask } = useTaskTracker();
  const [environmentId, setEnvironmentId] = useState<string>("");

  const environments = envData?.environments ?? [];
  const deployedEnvIds = new Set(stacks.map((s) => s.environmentId).filter(Boolean));

  // A template pinned to one network type can only go to environments of that
  // type — the server rejects the mismatch, so don't offer it.
  const eligible = environments.filter(
    (env) => !template.networkType || env.networkType === template.networkType,
  );

  async function handleDeploy() {
    if (!environmentId) return;
    await deployApplication.mutateAsync({
      templateId: template.id,
      name: template.name,
      environmentId,
      onStackCreated: (stackId) => {
        registerTask({
          id: stackId,
          type: "stack-apply",
          label: `Deploying ${template.displayName ?? template.name}`,
          channel: Channel.STACKS,
        });
      },
    });
    setEnvironmentId("");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy {template.displayName ?? template.name}</DialogTitle>
          <DialogDescription>
            Choose which environment to deploy into. An application can run in
            several environments at once.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label>Environment</Label>
          <Select value={environmentId} onValueChange={setEnvironmentId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose an environment" />
            </SelectTrigger>
            <SelectContent>
              {eligible.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">
                  No environment matches this application&apos;s network type (
                  {template.networkType}).
                </div>
              ) : (
                eligible.map((env) => {
                  const already = deployedEnvIds.has(env.id);
                  return (
                    <SelectItem key={env.id} value={env.id} disabled={already}>
                      <span className="flex items-center gap-2">
                        {env.name}
                        <Badge variant="outline" className="text-xs">
                          {env.networkType}
                        </Badge>
                        {already && (
                          <span className="text-xs text-muted-foreground">
                            already deployed
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  );
                })
              )}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deployApplication.isPending}
          >
            Cancel
          </Button>
          <Button
            disabled={!environmentId || deployApplication.isPending}
            onClick={handleDeploy}
            data-tour="application-deploy-confirm"
          >
            {deployApplication.isPending && (
              <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />
            )}
            Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
