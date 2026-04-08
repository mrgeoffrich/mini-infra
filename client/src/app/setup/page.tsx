import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  IconLoader2,
  IconAlertCircle,
  IconCheck,
  IconBrandDocker,
  IconKey,
  IconCopy,
  IconArrowRight,
  IconCircleCheck,
  IconCircleDashed,
} from "@tabler/icons-react";
import { useSetupStatus } from "@/hooks/use-setup-status";
import type { DockerSocketDetectionResult } from "@mini-infra/types";

// ---------------------------------------------------------------------------
// Step 1 — Create Account
// ---------------------------------------------------------------------------

function CreateAccountStep({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, displayName, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Setup failed");
        return;
      }

      onComplete();
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
          required
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="displayName">Display Name</Label>
        <Input
          id="displayName"
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Admin"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Min 8 chars, 1 letter, 1 number"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating account...
          </>
        ) : (
          <>
            Continue
            <IconArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Docker Socket Detection
// ---------------------------------------------------------------------------

function DockerDetectionStep({
  onComplete,
}: {
  onComplete: (dockerHost: string | null) => void;
}) {
  const [isDetecting, setIsDetecting] = useState(true);
  const [result, setResult] = useState<DockerSocketDetectionResult | null>(
    null,
  );
  const [selectedSocket, setSelectedSocket] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detect = useCallback(async () => {
    setIsDetecting(true);
    setError(null);
    try {
      const response = await fetch("/auth/setup/detect-docker", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Detection failed");
      }
      const data: DockerSocketDetectionResult = await response.json();
      setResult(data);
      if (data.detected && data.sockets.length > 0) {
        setSelectedSocket(data.sockets[0].displayPath);
      }
    } catch {
      setError("Failed to detect Docker socket");
    } finally {
      setIsDetecting(false);
    }
  }, []);

  useEffect(() => {
    detect();
  }, [detect]);

  if (isDetecting) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <IconLoader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Scanning for Docker sockets...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={detect}>
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onComplete(null)}>
            Skip
          </Button>
        </div>
      </div>
    );
  }

  if (!result?.detected) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No Docker socket was found at the common locations. You can configure
          the Docker connection later from the settings page.
        </p>
        <Button className="w-full" onClick={() => onComplete(null)}>
          Continue
          <IconArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {result.sockets.map((socket) => (
          <label
            key={socket.path}
            className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
              selectedSocket === socket.displayPath
                ? "border-primary bg-primary/5"
                : "border-muted hover:border-muted-foreground/30"
            }`}
          >
            <input
              type="radio"
              name="docker-socket"
              value={socket.displayPath}
              checked={selectedSocket === socket.displayPath}
              onChange={() => setSelectedSocket(socket.displayPath)}
              className="sr-only"
            />
            <IconCircleCheck
              className={`h-4 w-4 flex-shrink-0 ${
                selectedSocket === socket.displayPath
                  ? "text-primary"
                  : "text-muted-foreground/30"
              }`}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-mono truncate">{socket.displayPath}</p>
              {socket.version && (
                <p className="text-xs text-muted-foreground">
                  Docker {socket.version}
                </p>
              )}
            </div>
          </label>
        ))}
      </div>

      <Button
        className="w-full"
        onClick={() => onComplete(selectedSocket)}
        disabled={!selectedSocket}
      >
        Continue
        <IconArrowRight className="ml-2 h-4 w-4" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — App Secret
// ---------------------------------------------------------------------------

function AppSecretStep({
  onComplete,
  dockerHost,
}: {
  onComplete: () => void;
  dockerHost: string | null;
}) {
  const [appSecret, setAppSecret] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCompleting, setIsCompleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/auth/setup/app-secret");
        if (!response.ok) throw new Error("Failed to retrieve app secret");
        const data = await response.json();
        setAppSecret(data.appSecret);
      } catch {
        setError("Failed to load app secret");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const handleCopy = async () => {
    if (!appSecret) return;
    try {
      await navigator.clipboard.writeText(appSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for insecure contexts
      const textarea = document.createElement("textarea");
      textarea.value = appSecret;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const response = await fetch("/auth/setup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dockerHost }),
      });

      if (!response.ok) {
        throw new Error("Failed to complete setup");
      }

      onComplete();
    } catch {
      setError("Failed to complete setup");
    } finally {
      setIsCompleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <IconLoader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !appSecret) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        This secret is used to encrypt credentials and sign authentication
        tokens. If you ever need to restore from a backup or migrate to a new
        host, you will need this secret to decrypt your data.
      </p>

      <div className="relative">
        <div className="rounded-lg border bg-muted/50 p-3 pr-10 font-mono text-xs break-all select-all">
          {appSecret}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="absolute right-1 top-1 h-8 w-8 p-0"
          onClick={handleCopy}
        >
          {copied ? (
            <IconCheck className="h-4 w-4 text-green-600" />
          ) : (
            <IconCopy className="h-4 w-4" />
          )}
        </Button>
      </div>

      <Alert>
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Store this secret in a safe place. You can also set it as the{" "}
          <code className="rounded bg-muted px-1 py-0.5">APP_SECRET</code>{" "}
          environment variable to ensure the same secret is used across
          restarts.
        </AlertDescription>
      </Alert>

      {error && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button
        className="w-full"
        onClick={handleComplete}
        disabled={isCompleting}
      >
        {isCompleting ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            Completing setup...
          </>
        ) : (
          "I've saved it — Complete Setup"
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({
  number,
  icon,
  title,
  done,
  active,
}: {
  number: number;
  icon: React.ReactNode;
  title: string;
  done: boolean;
  active: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-shrink-0">
        {done ? (
          <IconCircleCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
        ) : (
          <IconCircleDashed
            className={`h-5 w-5 ${active ? "text-primary" : "text-muted-foreground/40"}`}
          />
        )}
      </div>
      <div
        className={`flex items-center gap-1.5 text-sm ${
          active ? "font-medium" : done ? "text-muted-foreground" : "text-muted-foreground/40"
        }`}
      >
        {icon}
        <span>
          {number}. {title}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Setup Page
// ---------------------------------------------------------------------------

export function SetupPage() {
  const navigate = useNavigate();
  const { data: setupStatus } = useSetupStatus();
  const [step, setStep] = useState(1);
  const [dockerHost, setDockerHost] = useState<string | null>(null);

  // If setup already has users (e.g. page refresh mid-wizard), skip to step 2
  useEffect(() => {
    if (setupStatus?.hasUsers && step === 1) {
      setStep(2);
    }
  }, [setupStatus?.hasUsers, step]);

  const stepTitles = [
    { icon: <IconAlertCircle className="h-3.5 w-3.5" />, title: "Create Account" },
    { icon: <IconBrandDocker className="h-3.5 w-3.5" />, title: "Docker Connection" },
    { icon: <IconKey className="h-3.5 w-3.5" />, title: "App Secret" },
  ];

  const stepDescription = {
    1: "Create your admin account to get started.",
    2: "Let's check if Docker is available on this host.",
    3: "Save your app secret for backup and recovery.",
  }[step];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Welcome to Mini Infra</CardTitle>
            <CardDescription>{stepDescription}</CardDescription>

            <div className="flex items-center gap-4 pt-2">
              {stepTitles.map((s, i) => (
                <StepIndicator
                  key={i}
                  number={i + 1}
                  icon={s.icon}
                  title={s.title}
                  done={step > i + 1}
                  active={step === i + 1}
                />
              ))}
            </div>
          </CardHeader>

          <CardContent>
            {step === 1 && (
              <CreateAccountStep onComplete={() => setStep(2)} />
            )}
            {step === 2 && (
              <DockerDetectionStep
                onComplete={(host) => {
                  setDockerHost(host);
                  setStep(3);
                }}
              />
            )}
            {step === 3 && (
              <AppSecretStep
                dockerHost={dockerHost}
                onComplete={() => navigate("/login")}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
