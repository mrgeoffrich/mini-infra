import { ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconShield, IconLogin } from "@tabler/icons-react";

interface NavigationGuardProps {
  children: ReactNode;
  requireAuth?: boolean;
  requireRole?: string; // For future role-based access control
  fallbackMessage?: string;
  showLoginPrompt?: boolean;
}

export function NavigationGuard({
  children,
  requireAuth = true,
  requireRole,
  fallbackMessage,
  showLoginPrompt = true,
}: NavigationGuardProps) {
  const { authState, login } = useAuth();

  // If authentication is required but user is not authenticated
  if (requireAuth && !authState.isAuthenticated && !authState.isLoading) {
    if (showLoginPrompt) {
      return (
        <Card className="w-full max-w-md mx-auto mt-8">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <IconShield className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>Authentication Required</CardTitle>
            <CardDescription>
              {fallbackMessage || "You need to sign in to access this section."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => login()} className="w-full">
              <IconLogin className="mr-2 h-4 w-4" />
              Sign In with Google
            </Button>
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">
          {fallbackMessage || "Authentication required to view this content."}
        </p>
      </div>
    );
  }

  // Future: Role-based access control
  if (requireRole && authState.user) {
    // This would check user roles when implemented
    // For now, all authenticated users have access
  }

  return <>{children}</>;
}
