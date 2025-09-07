import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useUserPreferences,
  useUpdateUserPreferences,
  useTimezones,
} from "@/hooks/use-user-preferences";
import { toast } from "sonner";
import {
  ArrowLeft,
  Save,
  Loader2,
  Clock,
  CheckCircle,
  AlertCircle,
  User,
} from "lucide-react";

// Form validation schema
const UserSettingsSchema = z.object({
  timezone: z.string().min(1, "Please select a timezone"),
});

type UserSettingsFormData = z.infer<typeof UserSettingsSchema>;

export function UserSettingsPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Query hooks
  const {
    data: preferences,
    isLoading: preferencesLoading,
    error: preferencesError,
  } = useUserPreferences();

  const {
    data: timezones,
    isLoading: timezonesLoading,
    error: timezonesError,
  } = useTimezones();

  const updatePreferencesMutation = useUpdateUserPreferences();

  // Form setup
  const form = useForm<UserSettingsFormData>({
    resolver: zodResolver(UserSettingsSchema),
    defaultValues: {
      timezone: preferences?.timezone || "UTC",
    },
  });

  // Update form when preferences load
  if (preferences && !form.getValues().timezone) {
    form.setValue("timezone", preferences.timezone || "UTC");
  }

  // Handle form submission
  const onSubmit = async (data: UserSettingsFormData) => {
    setIsSubmitting(true);
    
    try {
      await updatePreferencesMutation.mutateAsync({
        timezone: data.timezone,
      });
      
      toast.success("Settings updated successfully!");
    } catch (error: unknown) {
      console.error("Failed to update settings:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to update settings";
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Loading state
  if (preferencesLoading || timezonesLoading) {
    return (
      <div className="container mx-auto py-6 space-y-6">
        <div className="flex items-center gap-2 mb-6">
          <Skeleton className="h-6 w-6" />
          <Skeleton className="h-8 w-32" />
        </div>
        
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-3 w-64" />
            </div>
            <Skeleton className="h-10 w-24" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state
  if (preferencesError || timezonesError) {
    return (
      <div className="container mx-auto py-6">
        <div className="flex items-center gap-2 mb-6">
          <Link to="/dashboard" className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Link>
        </div>
        
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load user settings. {preferencesError?.message || timezonesError?.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const isDirty = form.formState.isDirty;
  const currentTimezone = preferences?.timezone || "UTC";

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <Link 
          to="/dashboard" 
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <User className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-semibold tracking-tight">User Settings</h1>
        </div>
        <p className="text-muted-foreground">
          Manage your personal preferences and settings
        </p>
      </div>

      {/* Settings Form */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle>Timezone Settings</CardTitle>
          </div>
          <CardDescription>
            Set your preferred timezone for displaying dates and times throughout the application
          </CardDescription>
        </CardHeader>

        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Timezone</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a timezone" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(timezones || []).map((timezone) => (
                          <SelectItem key={timezone.value} value={timezone.value}>
                            {timezone.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Current timezone: {currentTimezone} | 
                      Local time: {new Date().toLocaleString("en-US", { 
                        timeZone: form.watch("timezone") || currentTimezone,
                        dateStyle: "short",
                        timeStyle: "medium"
                      })}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-2">
                <Button
                  type="submit"
                  disabled={!isDirty || isSubmitting}
                  className="flex items-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Changes
                    </>
                  )}
                </Button>

                {isDirty && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => form.reset()}
                  >
                    Reset
                  </Button>
                )}
              </div>

              {!isDirty && preferences && (
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle className="h-4 w-4" />
                  All changes saved
                </div>
              )}
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}