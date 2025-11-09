import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  IconChevronDown,
  IconLoader2,
  IconPlus,
  IconEye,
  IconEyeOff,
  IconAlertTriangle,
  IconInfoCircle,
} from "@tabler/icons-react";
import { useManagedDatabaseUser } from "@/hooks/use-managed-database-users";
import {
  CreateManagedDatabaseUserRequest,
  UpdateManagedDatabaseUserRequest,
} from "@mini-infra/types";

// Validation schema for create mode
const createUserSchema = z.object({
  username: z
    .string()
    .min(1, "Username is required")
    .regex(
      /^[a-z0-9_]+$/,
      "Only lowercase letters, numbers, and underscores allowed",
    ),
  password: z.string().min(8, "Password must be at least 8 characters"),
  canLogin: z.boolean().default(true),
  isSuperuser: z.boolean().default(false),
  connectionLimit: z.number().default(-1),
});

// Validation schema for edit mode
const editUserSchema = z.object({
  canLogin: z.boolean().default(true),
  isSuperuser: z.boolean().default(false),
  connectionLimit: z.number().default(-1),
});

interface CreateUserModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "create";
  userId?: never;
  onSubmit: (data: CreateManagedDatabaseUserRequest) => Promise<void>;
}

interface EditUserModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "edit";
  userId: string;
  onSubmit: (data: UpdateManagedDatabaseUserRequest) => Promise<void>;
}

type UserModalProps = CreateUserModalProps | EditUserModalProps;

export function UserModal(props: UserModalProps) {
  if (props.mode === "create") {
    return <CreateUserModalContent {...props} />;
  }
  return <EditUserModalContent {...props} />;
}

function CreateUserModalContent({
  open,
  onOpenChange,
  onSubmit,
}: CreateUserModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<CreateManagedDatabaseUserRequest>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      username: "",
      password: "",
      canLogin: true,
      isSuperuser: false,
      connectionLimit: -1,
    },
  });

  const canLogin = watch("canLogin");
  const isSuperuser = watch("isSuperuser");

  const handleFormSubmit = async (data: CreateManagedDatabaseUserRequest) => {
    setIsSubmitting(true);
    try {
      await onSubmit(data);
      reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to create user:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isSubmitting) {
      reset();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create User</DialogTitle>
          <DialogDescription>Create a new database user</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(handleFormSubmit)}>
          <div className="space-y-4 py-4">
            {/* Username */}
            <div className="space-y-2">
              <Label htmlFor="username">Username *</Label>
              <Input
                id="username"
                placeholder="app_user"
                {...register("username")}
              />
              {errors.username && (
                <p className="text-sm text-destructive">
                  {errors.username.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and underscores only
              </p>
            </div>

            {/* Password */}
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
                <p className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Strong password recommended (12+ characters)
              </p>
            </div>

            {/* User Attributes */}
            <div className="space-y-3 rounded-lg border p-4">
              <h4 className="text-sm font-medium">User Attributes</h4>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canLogin">Can Login</Label>
                  <p className="text-xs text-muted-foreground">
                    Allow this user to connect to databases
                  </p>
                </div>
                <Switch
                  id="canLogin"
                  checked={canLogin}
                  onCheckedChange={(checked) => setValue("canLogin", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="isSuperuser">Superuser</Label>
                  <p className="text-xs text-muted-foreground">
                    Grant full administrative privileges
                  </p>
                </div>
                <Switch
                  id="isSuperuser"
                  checked={isSuperuser}
                  onCheckedChange={(checked) =>
                    setValue("isSuperuser", checked)
                  }
                />
              </div>

              {isSuperuser && (
                <Alert variant="destructive">
                  <IconAlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Superuser has unrestricted access to all databases and can
                    modify system settings.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {/* Advanced Options */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <span>Advanced Options</span>
                  <IconChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="connectionLimit">Connection Limit</Label>
                  <Input
                    id="connectionLimit"
                    type="number"
                    placeholder="-1 (unlimited)"
                    {...register("connectionLimit", { valueAsNumber: true })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum concurrent connections for this user
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <IconPlus className="h-4 w-4 mr-2" />
                  Create User
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserModalContent({
  open,
  onOpenChange,
  serverId,
  userId,
  onSubmit,
}: EditUserModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch user data
  const { data: userResponse } = useManagedDatabaseUser(serverId, userId);
  const existingUser = userResponse?.data;

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    watch,
    reset,
  } = useForm<UpdateManagedDatabaseUserRequest>({
    resolver: zodResolver(editUserSchema),
    defaultValues: {
      canLogin: true,
      isSuperuser: false,
      connectionLimit: -1,
    },
  });

  const canLogin = watch("canLogin");
  const isSuperuser = watch("isSuperuser");

  // Update form when existing user data loads
  useEffect(() => {
    if (existingUser) {
      setValue("canLogin", existingUser.canLogin);
      setValue("isSuperuser", existingUser.isSuperuser);
      setValue("connectionLimit", existingUser.connectionLimit);
    }
  }, [existingUser, setValue]);

  const handleFormSubmit = async (data: UpdateManagedDatabaseUserRequest) => {
    setIsSubmitting(true);
    try {
      await onSubmit(data);
      reset();
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to update user:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isSubmitting) {
      reset();
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>Update user attributes</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(handleFormSubmit)}>
          <div className="space-y-4 py-4">
            {/* Username display */}
            {existingUser && (
              <div className="space-y-2">
                <Label>Username</Label>
                <div className="font-mono text-sm p-2 bg-muted rounded-md">
                  {existingUser.username}
                </div>
                <p className="text-xs text-muted-foreground">
                  Username cannot be changed
                </p>
              </div>
            )}

            {/* User Attributes */}
            <div className="space-y-3 rounded-lg border p-4">
              <h4 className="text-sm font-medium">User Attributes</h4>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="canLogin">Can Login</Label>
                  <p className="text-xs text-muted-foreground">
                    Allow this user to connect to databases
                  </p>
                </div>
                <Switch
                  id="canLogin"
                  checked={canLogin}
                  onCheckedChange={(checked) => setValue("canLogin", checked)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="isSuperuser">Superuser</Label>
                  <p className="text-xs text-muted-foreground">
                    Grant full administrative privileges
                  </p>
                </div>
                <Switch
                  id="isSuperuser"
                  checked={isSuperuser}
                  onCheckedChange={(checked) =>
                    setValue("isSuperuser", checked)
                  }
                />
              </div>

              {isSuperuser && (
                <Alert variant="destructive">
                  <IconAlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Superuser has unrestricted access to all databases and can
                    modify system settings.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            {/* Advanced Options */}
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between"
                >
                  <span>Advanced Options</span>
                  <IconChevronDown className="h-4 w-4" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="connectionLimit">Connection Limit</Label>
                  <Input
                    id="connectionLimit"
                    type="number"
                    placeholder="-1 (unlimited)"
                    {...register("connectionLimit", { valueAsNumber: true })}
                  />
                  {errors.connectionLimit && (
                    <p className="text-sm text-destructive">
                      {errors.connectionLimit.message}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Maximum concurrent connections for this user
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>

            {/* Change Password Note */}
            <Alert>
              <IconInfoCircle className="h-4 w-4" />
              <AlertDescription>
                To change the password, use the "Change Password" action from
                the user menu.
              </AlertDescription>
            </Alert>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
