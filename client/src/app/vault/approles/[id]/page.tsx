import { useParams, Link } from "react-router-dom";
import { IconArrowLeft, IconUpload } from "@tabler/icons-react";
import {
  useVaultAppRole,
  useApplyVaultAppRole,
  useAppRoleStacks,
} from "@/hooks/use-vault";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export default function VaultAppRoleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: role, isLoading } = useVaultAppRole(id);
  const { data: boundStacks } = useAppRoleStacks(id);
  const apply = useApplyVaultAppRole();

  if (isLoading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>;
  if (!role) return <div className="p-6">AppRole not found</div>;

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/vault/approles">
              <IconArrowLeft className="h-4 w-4 mr-1" /> Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold font-mono">{role.name}</h1>
            <p className="text-muted-foreground text-sm">
              Policy: {role.policyName}
            </p>
          </div>
        </div>
        <Button
          onClick={() => apply.mutate(role.id)}
          disabled={apply.isPending}
        >
          <IconUpload className="h-4 w-4 mr-1" /> Apply to Vault
        </Button>
      </div>

      <div className="px-4 lg:px-6 max-w-4xl flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-sm text-muted-foreground">role_id</dt>
                <dd className="font-mono text-sm">
                  {role.cachedRoleId ?? "(not yet applied)"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  secret_id_num_uses
                </dt>
                <dd>{role.secretIdNumUses}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">token_period</dt>
                <dd>{role.tokenPeriod ?? "(unset)"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">token_ttl</dt>
                <dd>{role.tokenTtl ?? "(default)"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">token_max_ttl</dt>
                <dd>{role.tokenMaxTtl ?? "(default)"}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">lastAppliedAt</dt>
                <dd className="text-sm">
                  {role.lastAppliedAt
                    ? new Date(role.lastAppliedAt).toLocaleString()
                    : "(never)"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bound Stacks</CardTitle>
            <CardDescription>
              Stacks that mint credentials from this AppRole at apply time
            </CardDescription>
          </CardHeader>
          <CardContent>
            {(boundStacks ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No stacks are bound to this AppRole.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {(boundStacks ?? []).map((s) => (
                  <Badge key={s.id} variant="outline" className="text-sm">
                    {s.name}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
