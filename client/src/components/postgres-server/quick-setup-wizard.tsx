import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  IconCheck,
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconDatabase,
  IconUser,
  IconShield,
  IconCircleCheck,
  IconCopy,
  IconInfoCircle,
  IconLoader2,
  IconEye,
  IconEyeOff,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Alert, AlertDescription } from "../ui/alert";
import { Separator } from "../ui/separator";
import { cn } from "../../lib/utils";
import { useQuickSetup } from "../../hooks/use-quick-setup";
import type { QuickSetupResponse } from "@mini-infra/types";

// Wizard steps
const STEPS = ["Database", "User", "Review", "Complete"];

// Validation schema
const quickSetupSchema = z.object({
  databaseName: z
    .string()
    .min(1, "Database name is required")
    .regex(/^[a-z0-9_]+$/, "Only lowercase letters, numbers, and underscores allowed"),
  username: z
    .string()
    .min(1, "Username is required")
    .regex(/^[a-z0-9_]+$/, "Only lowercase letters, numbers, and underscores allowed"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type QuickSetupFormData = z.infer<typeof quickSetupSchema>;

interface QuickSetupWizardProps {
  serverId: string;
}

export function QuickSetupWizard({ serverId }: QuickSetupWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [result, setResult] = useState<QuickSetupResponse["data"] | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
    getValues,
    reset,
  } = useForm<QuickSetupFormData>({
    resolver: zodResolver(quickSetupSchema),
    mode: "onChange",
  });

  const quickSetupMutation = useQuickSetup(serverId);

  // Check if current step is valid to proceed
  const canProceed = () => {
    const values = getValues();
    if (currentStep === 0) {
      return values.databaseName && !errors.databaseName;
    }
    if (currentStep === 1) {
      return values.username && values.password && !errors.username && !errors.password;
    }
    return false;
  };

  // Handle next button
  const handleNext = () => {
    if (canProceed() && currentStep < 2) {
      setCurrentStep(currentStep + 1);
    }
  };

  // Handle previous button
  const handlePrevious = () => {
    if (currentStep > 0 && currentStep < 3) {
      setCurrentStep(currentStep - 1);
    }
  };

  // Handle form submission
  const onSubmit = async (data: QuickSetupFormData) => {
    try {
      const response = await quickSetupMutation.mutateAsync(data);
      setResult(response.data);
      setCurrentStep(3); // Move to success step
      toast.success("Application database created successfully!");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to create application database");
    }
  };

  // Handle reset to create another
  const handleReset = () => {
    reset();
    setCurrentStep(0);
    setResult(null);
    setShowPassword(false);
  };

  // Handle copy connection string
  const handleCopyConnectionString = () => {
    if (result?.connectionString) {
      navigator.clipboard.writeText(result.connectionString);
      toast.success("Connection string copied!");
    }
  };

  const formData = getValues();

  return (
    <div className="space-y-6">
      {/* Progress Indicator */}
      <div className="flex items-center justify-between">
        {STEPS.map((stepName, index) => (
          <div key={stepName} className="flex items-center flex-1">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  "flex items-center justify-center w-8 h-8 rounded-full border-2",
                  index < currentStep && "bg-primary border-primary text-primary-foreground",
                  index === currentStep && "border-primary text-primary",
                  index > currentStep && "border-muted text-muted-foreground",
                )}
              >
                {index < currentStep ? (
                  <IconCheck className="h-4 w-4" />
                ) : (
                  <span className="text-sm font-medium">{index + 1}</span>
                )}
              </div>
              <span
                className={cn(
                  "text-sm font-medium hidden md:inline",
                  index === currentStep && "text-foreground",
                  index !== currentStep && "text-muted-foreground",
                )}
              >
                {stepName}
              </span>
            </div>
            {index < STEPS.length - 1 && <div className="flex-1 h-0.5 mx-2 bg-border" />}
          </div>
        ))}
      </div>

      {/* Step Content */}
      <form onSubmit={handleSubmit(onSubmit)}>
        {/* Step 1: Database Details */}
        {currentStep === 0 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="databaseName">Database Name *</Label>
              <Input
                id="databaseName"
                placeholder="my_app_database"
                {...register("databaseName")}
              />
              {errors.databaseName && (
                <p className="text-sm text-destructive">{errors.databaseName.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores only
              </p>
            </div>

            <Alert>
              <IconInfoCircle className="h-4 w-4" />
              <AlertDescription>
                This will create a new database with UTF8 encoding and template0.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Step 2: User Credentials */}
        {currentStep === 1 && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username *</Label>
              <Input id="username" placeholder="app_user" {...register("username")} />
              {errors.username && (
                <p className="text-sm text-destructive">{errors.username.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores only
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password *</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  {...register("password")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <IconEyeOff className="h-4 w-4" />
                  ) : (
                    <IconEye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {errors.password && (
                <p className="text-sm text-destructive">{errors.password.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Strong password recommended (12+ characters)
              </p>
            </div>

            <Alert>
              <IconInfoCircle className="h-4 w-4" />
              <AlertDescription>
                This user will be created with full permissions on the database (SELECT, INSERT,
                UPDATE, DELETE).
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Step 3: Review */}
        {currentStep === 2 && (
          <div className="space-y-4">
            <Alert>
              <IconInfoCircle className="h-4 w-4" />
              <AlertDescription>Review your configuration before creating.</AlertDescription>
            </Alert>

            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <IconDatabase className="h-5 w-5 text-purple-600 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold">Database</div>
                  <div className="text-sm text-muted-foreground font-mono">
                    {formData.databaseName}
                  </div>
                </div>
              </div>

              <Separator />

              <div className="flex items-start gap-3">
                <IconUser className="h-5 w-5 text-blue-600 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold">User</div>
                  <div className="text-sm text-muted-foreground font-mono">
                    {formData.username}
                  </div>
                </div>
              </div>

              <Separator />

              <div className="flex items-start gap-3">
                <IconShield className="h-5 w-5 text-green-600 mt-0.5" />
                <div className="flex-1">
                  <div className="font-semibold">Permissions</div>
                  <div className="text-sm text-muted-foreground">
                    Full access (CONNECT, SELECT, INSERT, UPDATE, DELETE)
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Success */}
        {currentStep === 3 && result && (
          <div className="space-y-4">
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <div className="p-4 rounded-full bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300 mb-4">
                <IconCircleCheck className="h-12 w-12" />
              </div>
              <h3 className="text-lg font-semibold mb-2">Successfully Created!</h3>
              <p className="text-muted-foreground max-w-md">
                Your database, user, and permissions have been configured.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Connection String</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={result.connectionString}
                  className="font-mono text-sm"
                />
                <Button type="button" variant="outline" onClick={handleCopyConnectionString}>
                  <IconCopy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Use this connection string in your application
              </p>
            </div>

            <Alert>
              <IconInfoCircle className="h-4 w-4" />
              <AlertDescription>
                Save this connection string securely. You can also find the database and user in
                their respective tabs.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {/* Navigation Buttons */}
        <div className="flex justify-between pt-6 border-t">
          <Button
            type="button"
            variant="outline"
            onClick={handlePrevious}
            disabled={currentStep === 0 || currentStep === 3}
          >
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Previous
          </Button>

          {currentStep < 2 && (
            <Button type="button" onClick={handleNext} disabled={!canProceed()}>
              Next
              <IconArrowRight className="h-4 w-4 ml-2" />
            </Button>
          )}

          {currentStep === 2 && (
            <Button type="submit" disabled={quickSetupMutation.isPending}>
              {quickSetupMutation.isPending ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <IconBolt className="h-4 w-4 mr-2" />
                  Create Everything
                </>
              )}
            </Button>
          )}

          {currentStep === 3 && (
            <Button type="button" onClick={handleReset}>
              Create Another
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
