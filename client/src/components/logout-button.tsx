import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useLogout } from "@/hooks/use-logout";
import { IconLoader2 } from "@tabler/icons-react";
import { useState } from "react";

interface LogoutButtonProps {
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  size?: "default" | "sm" | "lg" | "icon";
  showConfirmation?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function LogoutButton({
  variant = "outline",
  size = "default",
  showConfirmation = true,
  className,
  children,
}: LogoutButtonProps) {
  const { logout, isLoggingOut, error } = useLogout();
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await logout();
      setIsDialogOpen(false);
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  const handleDirectLogout = async () => {
    if (!showConfirmation) {
      await handleLogout();
    } else {
      setIsDialogOpen(true);
    }
  };

  if (showConfirmation) {
    return (
      <AlertDialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <AlertDialogTrigger asChild>
          <Button
            variant={variant}
            size={size}
            disabled={isLoggingOut}
            className={className}
            onClick={handleDirectLogout}
          >
            {isLoggingOut ? (
              <>
                <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing out...
              </>
            ) : (
              children || "Sign out"
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Sign Out</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to sign out? You will need to authenticate
              again to access the dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <div className="text-sm text-destructive mt-2">Error: {error}</div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isLoggingOut}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLoggingOut ? (
                <>
                  <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing out...
                </>
              ) : (
                "Sign out"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      disabled={isLoggingOut}
      className={className}
      onClick={handleLogout}
    >
      {isLoggingOut ? (
        <>
          <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
          Signing out...
        </>
      ) : (
        children || "Sign out"
      )}
    </Button>
  );
}
