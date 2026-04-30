import { Link } from "react-router-dom";
import { IconCloud, IconRefresh, IconPlus, IconKey, IconMessages, IconUsers } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useApplyNats,
  useCreateNatsAccount,
  useCreateNatsConsumer,
  useCreateNatsCredential,
  useCreateNatsStream,
  useMintNatsCredential,
  useNatsAccounts,
  useNatsConsumers,
  useNatsCredentials,
  useNatsStatus,
  useNatsStreams,
} from "@/hooks/use-nats";
import { toast } from "sonner";

type NatsView = "overview" | "accounts" | "credentials" | "streams" | "consumers";

interface Props {
  view?: NatsView;
}

const nav = [
  { to: "/nats/accounts", label: "Accounts", icon: IconUsers },
  { to: "/nats/credentials", label: "Credentials", icon: IconKey },
  { to: "/nats/streams", label: "Streams", icon: IconMessages },
  { to: "/nats/consumers", label: "Consumers", icon: IconCloud },
];

export default function NatsPage({ view = "overview" }: Props) {
  const status = useNatsStatus();
  const apply = useApplyNats();

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-sky-100 p-3 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
              <IconCloud className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">NATS</h1>
              <p className="text-muted-foreground">Managed accounts, scoped credentials, streams, and consumers</p>
            </div>
          </div>
          <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
            <IconRefresh className="mr-2 h-4 w-4" />
            Apply
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant={view === "overview" ? "default" : "outline"} asChild>
            <Link to="/nats">Overview</Link>
          </Button>
          {nav.map((item) => (
            <Button key={item.to} variant={view === item.label.toLowerCase() ? "default" : "outline"} asChild>
              <Link to={item.to}>
                <item.icon className="mr-2 h-4 w-4" />
                {item.label}
              </Link>
            </Button>
          ))}
        </div>

        {view === "overview" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Metric title="Reachability" value={status.data?.reachable ? "Reachable" : "Unavailable"} tone={status.data?.reachable ? "success" : "muted"} />
            <Metric title="Accounts" value={String(status.data?.accounts ?? 0)} />
            <Metric title="Credential Profiles" value={String(status.data?.credentialProfiles ?? 0)} />
            <Metric title="JetStream Objects" value={`${status.data?.streams ?? 0} / ${status.data?.consumers ?? 0}`} />
            <Card className="md:col-span-2 xl:col-span-4">
              <CardHeader>
                <CardTitle>Endpoint</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>Client: <span className="font-mono">{status.data?.clientUrl ?? "Not registered"}</span></div>
                <div>Monitor: <span className="font-mono">{status.data?.monitorUrl ?? "Not registered"}</span></div>
                {status.data?.errorMessage && <div className="text-destructive">{status.data.errorMessage}</div>}
              </CardContent>
            </Card>
          </div>
        )}

        {view === "accounts" && <AccountsView />}
        {view === "credentials" && <CredentialsView />}
        {view === "streams" && <StreamsView />}
        {view === "consumers" && <ConsumersView />}
      </div>
    </div>
  );
}

function Metric({ title, value, tone = "default" }: { title: string; value: string; tone?: "default" | "success" | "muted" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Badge variant={tone === "success" ? "default" : "secondary"}>{value}</Badge>
      </CardContent>
    </Card>
  );
}

function AccountsView() {
  const accounts = useNatsAccounts();
  const create = useCreateNatsAccount();
  return (
    <ResourceSection
      title="Accounts"
      onCreate={() => {
        const name = prompt("Account name");
        if (!name) return;
        create.mutate({ name, displayName: name });
      }}
      rows={(accounts.data ?? []).map((a) => [a.name, a.displayName, a.publicKey ?? "not applied", a.isSystem ? "system" : "user"])}
    />
  );
}

function CredentialsView() {
  const credentials = useNatsCredentials();
  const accounts = useNatsAccounts();
  const create = useCreateNatsCredential();
  const mint = useMintNatsCredential();
  return (
    <ResourceSection
      title="Credential Profiles"
      onCreate={() => {
        const accountId = accounts.data?.[0]?.id;
        const name = prompt("Credential profile name");
        if (!name || !accountId) return;
        create.mutate({ name, displayName: name, accountId, publishAllow: [">"], subscribeAllow: [">"], ttlSeconds: 3600 });
      }}
      rows={(credentials.data ?? []).map((c) => [c.name, c.accountName, c.publishAllow.join(", "), c.subscribeAllow.join(", ")])}
      action={(idx) => {
        const credential = credentials.data?.[idx];
        if (!credential) return;
        mint.mutate(credential.id, {
          onSuccess: (data) => {
            navigator.clipboard.writeText(data.creds).catch(() => undefined);
            toast.success("Credentials minted and copied");
          },
        });
      }}
      actionLabel="Mint"
    />
  );
}

function StreamsView() {
  const streams = useNatsStreams();
  const accounts = useNatsAccounts();
  const create = useCreateNatsStream();
  return (
    <ResourceSection
      title="Streams"
      onCreate={() => {
        const accountId = accounts.data?.[0]?.id;
        const name = prompt("Stream name");
        const subject = prompt("Subject", `${name ?? "events"}.>`);
        if (!name || !subject || !accountId) return;
        create.mutate({ name, accountId, subjects: [subject], retention: "limits", storage: "file" });
      }}
      rows={(streams.data ?? []).map((s) => [s.name, s.accountName, s.subjects.join(", "), `${s.retention}/${s.storage}`])}
    />
  );
}

function ConsumersView() {
  const consumers = useNatsConsumers();
  const streams = useNatsStreams();
  const create = useCreateNatsConsumer();
  return (
    <ResourceSection
      title="Consumers"
      onCreate={() => {
        const streamId = streams.data?.[0]?.id;
        const name = prompt("Consumer name");
        if (!name || !streamId) return;
        create.mutate({ name, streamId, durableName: name, deliverPolicy: "all", ackPolicy: "explicit" });
      }}
      rows={(consumers.data ?? []).map((c) => [c.name, c.streamName, c.durableName ?? "", `${c.deliverPolicy}/${c.ackPolicy}`])}
    />
  );
}

function ResourceSection({
  title,
  rows,
  onCreate,
  action,
  actionLabel,
}: {
  title: string;
  rows: string[][];
  onCreate: () => void;
  action?: (idx: number) => void;
  actionLabel?: string;
}) {
  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <Button onClick={onCreate}>
          <IconPlus className="mr-2 h-4 w-4" />
          New
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {rows.length === 0 ? (
                <tr><td className="py-8 text-muted-foreground">No records</td></tr>
              ) : rows.map((row, idx) => (
                <tr key={`${row[0]}-${idx}`} className="border-t">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="py-3 pr-4">{cell}</td>
                  ))}
                  {action && (
                    <td className="py-3 text-right">
                      <Button size="sm" variant="outline" onClick={() => action(idx)}>{actionLabel}</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
