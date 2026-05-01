import { useState } from "react";
import { Link } from "react-router-dom";
import { IconCloud, IconRefresh, IconPlus, IconKey, IconMessages, IconUsers } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type {
  NatsAccountInfo,
  NatsStreamInfo,
} from "@mini-infra/types";

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
  const [open, setOpen] = useState(false);
  return (
    <>
      <ResourceSection
        title="Accounts"
        onCreate={() => setOpen(true)}
        rows={(accounts.data ?? []).map((a) => [a.name, a.displayName, a.publicKey ?? "not applied", a.isSystem ? "system" : "user"])}
      />
      <CreateAccountDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function CredentialsView() {
  const credentials = useNatsCredentials();
  const mint = useMintNatsCredential();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ResourceSection
        title="Credential Profiles"
        onCreate={() => setOpen(true)}
        rows={(credentials.data ?? []).map((c) => [c.name, c.accountName, c.publishAllow.join(", "), c.subscribeAllow.join(", ")])}
        action={(idx) => {
          const credential = credentials.data?.[idx];
          if (!credential) return;
          mint.mutate(credential.id, {
            onSuccess: (data) => {
              navigator.clipboard.writeText(data.creds).catch(() => undefined);
              toast.success("Credentials minted and copied");
            },
            onError: (err) => toast.error(err instanceof Error ? err.message : "Mint failed"),
          });
        }}
        actionLabel="Mint"
      />
      <CreateCredentialDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function StreamsView() {
  const streams = useNatsStreams();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ResourceSection
        title="Streams"
        onCreate={() => setOpen(true)}
        rows={(streams.data ?? []).map((s) => [s.name, s.accountName, s.subjects.join(", "), `${s.retention}/${s.storage}`])}
      />
      <CreateStreamDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function ConsumersView() {
  const consumers = useNatsConsumers();
  const [open, setOpen] = useState(false);
  return (
    <>
      <ResourceSection
        title="Consumers"
        onCreate={() => setOpen(true)}
        rows={(consumers.data ?? []).map((c) => [c.name, c.streamName, c.durableName ?? "", `${c.deliverPolicy}/${c.ackPolicy}`])}
      />
      <CreateConsumerDialog open={open} onOpenChange={setOpen} />
    </>
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

function CreateAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const create = useCreateNatsAccount();

  const reset = () => {
    setName("");
    setDisplayName("");
    setDescription("");
  };

  const submit = async () => {
    try {
      await create.mutateAsync({
        name,
        displayName: displayName || name,
        description: description || undefined,
      });
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create account failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New NATS account</DialogTitle>
          <DialogDescription>
            Accounts are signed by the operator NKey and isolate subjects from each other.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-name">Name (lowercase, alphanum + hyphen/underscore)</Label>
            <Input id="account-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-team" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-display">Display name</Label>
            <Input id="account-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Team" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="account-desc">Description (optional)</Label>
            <Input id="account-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateCredentialDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const accounts = useNatsAccounts();
  const create = useCreateNatsCredential();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [accountId, setAccountId] = useState<string>("");
  const [publishAllow, setPublishAllow] = useState(">");
  const [subscribeAllow, setSubscribeAllow] = useState(">");
  const [ttl, setTtl] = useState("3600");

  const reset = () => {
    setName("");
    setDisplayName("");
    setAccountId("");
    setPublishAllow(">");
    setSubscribeAllow(">");
    setTtl("3600");
  };

  const submit = async () => {
    const resolvedAccount = accountId || accounts.data?.[0]?.id;
    if (!resolvedAccount) {
      toast.error("Create an account first");
      return;
    }
    try {
      await create.mutateAsync({
        name,
        displayName: displayName || name,
        accountId: resolvedAccount,
        publishAllow: splitSubjects(publishAllow),
        subscribeAllow: splitSubjects(subscribeAllow),
        ttlSeconds: Number(ttl) || 3600,
      });
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create credential failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New credential profile</DialogTitle>
          <DialogDescription>
            A reusable bundle of publish/subscribe permissions. Mint a `.creds` from it on demand.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-name">Name</Label>
            <Input id="cred-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="manager-creds" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-display">Display name</Label>
            <Input id="cred-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <AccountSelector accounts={accounts.data ?? []} value={accountId} onChange={setAccountId} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-pub">Publish allow (comma or newline separated)</Label>
            <Textarea id="cred-pub" rows={2} value={publishAllow} onChange={(e) => setPublishAllow(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-sub">Subscribe allow</Label>
            <Textarea id="cred-sub" rows={2} value={subscribeAllow} onChange={(e) => setSubscribeAllow(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="cred-ttl">Default TTL (seconds, 0 = no expiry)</Label>
            <Input id="cred-ttl" type="number" min={0} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateStreamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const accounts = useNatsAccounts();
  const create = useCreateNatsStream();
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState<string>("");
  const [subjects, setSubjects] = useState("");
  const [retention, setRetention] = useState<"limits" | "interest" | "workqueue">("limits");
  const [storage, setStorage] = useState<"file" | "memory">("file");

  const reset = () => {
    setName("");
    setAccountId("");
    setSubjects("");
    setRetention("limits");
    setStorage("file");
  };

  const submit = async () => {
    const resolvedAccount = accountId || accounts.data?.[0]?.id;
    if (!resolvedAccount) {
      toast.error("Create an account first");
      return;
    }
    try {
      await create.mutateAsync({
        name,
        accountId: resolvedAccount,
        subjects: splitSubjects(subjects || `${name}.>`),
        retention,
        storage,
      });
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create stream failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New JetStream stream</DialogTitle>
          <DialogDescription>
            Subjects, retention, and storage type are applied to the live NATS server on Apply.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="stream-name">Name</Label>
            <Input id="stream-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders" />
          </div>
          <AccountSelector accounts={accounts.data ?? []} value={accountId} onChange={setAccountId} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="stream-subjects">Subjects (comma or newline separated)</Label>
            <Textarea
              id="stream-subjects"
              rows={2}
              value={subjects}
              onChange={(e) => setSubjects(e.target.value)}
              placeholder={`${name || "orders"}.>`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label>Retention</Label>
              <Select value={retention} onValueChange={(v) => setRetention(v as typeof retention)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="limits">limits</SelectItem>
                  <SelectItem value="interest">interest</SelectItem>
                  <SelectItem value="workqueue">workqueue</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Storage</Label>
              <Select value={storage} onValueChange={(v) => setStorage(v as typeof storage)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="file">file</SelectItem>
                  <SelectItem value="memory">memory</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateConsumerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const streams = useNatsStreams();
  const create = useCreateNatsConsumer();
  const [name, setName] = useState("");
  const [streamId, setStreamId] = useState<string>("");
  const [durableName, setDurableName] = useState("");
  const [filterSubject, setFilterSubject] = useState("");
  const [deliverPolicy, setDeliverPolicy] = useState<"all" | "last" | "new">("all");
  const [ackPolicy, setAckPolicy] = useState<"explicit" | "all" | "none">("explicit");

  const reset = () => {
    setName("");
    setStreamId("");
    setDurableName("");
    setFilterSubject("");
    setDeliverPolicy("all");
    setAckPolicy("explicit");
  };

  const submit = async () => {
    const resolvedStream = streamId || streams.data?.[0]?.id;
    if (!resolvedStream) {
      toast.error("Create a stream first");
      return;
    }
    try {
      await create.mutateAsync({
        name,
        streamId: resolvedStream,
        durableName: durableName || name,
        filterSubject: filterSubject || undefined,
        deliverPolicy,
        ackPolicy,
      });
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create consumer failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New JetStream consumer</DialogTitle>
          <DialogDescription>
            Pulls messages from a stream with the given delivery and ack policy.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="consumer-name">Name</Label>
            <Input id="consumer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders-worker" />
          </div>
          <StreamSelector streams={streams.data ?? []} value={streamId} onChange={setStreamId} />
          <div className="flex flex-col gap-2">
            <Label htmlFor="consumer-durable">Durable name (defaults to name)</Label>
            <Input id="consumer-durable" value={durableName} onChange={(e) => setDurableName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="consumer-filter">Filter subject (optional)</Label>
            <Input id="consumer-filter" value={filterSubject} onChange={(e) => setFilterSubject(e.target.value)} placeholder="orders.created" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label>Deliver policy</Label>
              <Select value={deliverPolicy} onValueChange={(v) => setDeliverPolicy(v as typeof deliverPolicy)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="last">last</SelectItem>
                  <SelectItem value="new">new</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Ack policy</Label>
              <Select value={ackPolicy} onValueChange={(v) => setAckPolicy(v as typeof ackPolicy)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="explicit">explicit</SelectItem>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="none">none</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountSelector({
  accounts,
  value,
  onChange,
}: {
  accounts: NatsAccountInfo[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Account</Label>
      <Select value={value || accounts[0]?.id || ""} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
        <SelectContent>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.displayName} ({a.name})</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function StreamSelector({
  streams,
  value,
  onChange,
}: {
  streams: NatsStreamInfo[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Stream</Label>
      <Select value={value || streams[0]?.id || ""} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Select stream" /></SelectTrigger>
        <SelectContent>
          {streams.map((s) => (
            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function splitSubjects(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
