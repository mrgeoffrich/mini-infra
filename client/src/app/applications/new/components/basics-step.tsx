import { useEffect } from "react";
import { useFormContext } from "react-hook-form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Environment } from "@mini-infra/types";
import type { CreateApplicationFormData } from "@/lib/application-schemas";

interface Props {
  environments: Environment[];
  isLoading: boolean;
}

export function BasicsStep({ environments, isLoading }: Props) {
  const form = useFormContext<CreateApplicationFormData>();
  const currentEnvId = form.watch("environmentId");

  useEffect(() => {
    if (!isLoading && environments.length === 1 && !currentEnvId) {
      form.setValue("environmentId", environments[0].id, {
        shouldValidate: true,
      });
    }
  }, [isLoading, environments, currentEnvId, form]);

  const hasSingleEnv = environments.length === 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Application</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="displayName"
            render={({ field }) => (
              <FormItem data-tour="new-app-display-name-input">
                <FormLabel>Name</FormLabel>
                <FormControl>
                  <Input placeholder="My Application" autoFocus {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="environmentId"
            render={({ field }) => (
              <FormItem data-tour="new-app-environment-select">
                <FormLabel>Environment</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  value={field.value ?? ""}
                  disabled={hasSingleEnv || isLoading}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue
                        placeholder={
                          isLoading
                            ? "Loading environments..."
                            : "Select an environment"
                        }
                      />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {environments.map((env) => (
                      <SelectItem key={env.id} value={env.id}>
                        {env.name}
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({env.networkType})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}
