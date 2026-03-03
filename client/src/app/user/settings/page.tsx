import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useUserPreferences,
  useUpdateUserPreferences,
  useTimezones,
} from "@/hooks/use-user-preferences";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  IconDeviceFloppy,
  IconLoader2,
  IconClock,
  IconCircleCheck,
  IconAlertCircle,
  IconUser,
  IconCheck,
  IconSelector,
} from "@tabler/icons-react";

// Form validation schema
const UserSettingsSchema = z.object({
  timezone: z.string().min(1, "Please select a timezone"),
});

type UserSettingsFormData = z.infer<typeof UserSettingsSchema>;

export function UserSettingsPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timezonePopoverOpen, setTimezonePopoverOpen] = useState(false);

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
      const errorMessage =
        error instanceof Error ? error.message : "Failed to update settings";
      toast.error(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Loading state
  if (preferencesLoading || timezonesLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Skeleton className="h-12 w-12" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 lg:px-6 max-w-6xl">
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
      </div>
    );
  }

  // Error state
  if (preferencesError || timezonesError) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-md bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300">
                <IconUser className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-3xl font-bold">User Settings</h1>
                <p className="text-muted-foreground">
                  Manage your personal preferences and settings
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 lg:px-6 max-w-6xl">
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load user settings.{" "}
              {preferencesError?.message || timezonesError?.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  const isDirty = form.formState.isDirty;
  const currentTimezone = preferences?.timezone || "UTC";

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconUser className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">User Settings</h1>
              <p className="text-muted-foreground">
                Manage your personal preferences and settings
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        <div className="grid gap-6">
          {/* Settings Form */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <IconClock className="h-5 w-5 text-primary" />
                <CardTitle>Timezone Settings</CardTitle>
              </div>
              <CardDescription>
                Set your preferred timezone for displaying dates and times
                throughout the application
              </CardDescription>
            </CardHeader>

            <CardContent>
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(onSubmit)}
                  className="space-y-6"
                >
                  <FormField
                    control={form.control}
                    name="timezone"
                    render={({ field }) => (
                      <FormItem className="flex flex-col max-w-[400px]">
                        <FormLabel>Timezone</FormLabel>
                        <Popover
                          open={timezonePopoverOpen}
                          onOpenChange={setTimezonePopoverOpen}
                        >
                          <PopoverTrigger asChild>
                            <FormControl>
                              <Button
                                variant="outline"
                                role="combobox"
                                className={cn(
                                  "w-full justify-between",
                                  !field.value && "text-muted-foreground",
                                )}
                              >
                                {field.value
                                  ? timezones?.find(
                                      (timezone) =>
                                        timezone.value === field.value,
                                    )?.label
                                  : "Select a timezone"}
                                <IconSelector className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </FormControl>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-[400px] max-w-[400px] p-0"
                            align="start"
                          >
                            <Command>
                              <CommandInput placeholder="Search timezones..." />
                              <CommandList>
                                <CommandEmpty>No timezone found.</CommandEmpty>
                                <CommandGroup>
                                  {(timezones || []).map((timezone) => (
                                    <CommandItem
                                      value={timezone.label}
                                      key={timezone.value}
                                      onSelect={() => {
                                        field.onChange(timezone.value);
                                        setTimezonePopoverOpen(false);
                                      }}
                                    >
                                      <IconCheck
                                        className={cn(
                                          "mr-2 h-4 w-4",
                                          timezone.value === field.value
                                            ? "opacity-100"
                                            : "opacity-0",
                                        )}
                                      />
                                      {timezone.label}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                        <FormDescription>
                          Current timezone: {currentTimezone} | Local time:{" "}
                          {new Date().toLocaleString("en-US", {
                            timeZone: form.watch("timezone") || currentTimezone,
                            dateStyle: "short",
                            timeStyle: "medium",
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
                          <IconLoader2 className="h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <IconDeviceFloppy className="h-4 w-4" />
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
                      <IconCircleCheck className="h-4 w-4" />
                      All changes saved
                    </div>
                  )}
                </form>
              </Form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
