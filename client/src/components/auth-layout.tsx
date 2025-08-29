import { useAuth } from "@/hooks/use-auth";
import { AuthSpinner, FullPageAuthSpinner } from "./auth-spinner";
import { AuthErrorDisplay } from "./auth-error";
import { LoginForm } from "./login-form";
import { UserProfile } from "./user-profile";
import { LogoutButton } from "./logout-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface AuthLayoutProps {
  children?: React.ReactNode;
  showUserProfile?: boolean;
  showLogoutButton?: boolean;
  fullPage?: boolean;
  className?: string;
}

export function AuthLayout({
  children,
  showUserProfile = false,
  showLogoutButton = false,
  fullPage = false,
  className = "",
}: AuthLayoutProps) {
  const { authState, refetch } = useAuth();
  const { isLoading, isAuthenticated, error } = authState;

  if (isLoading) {
    return fullPage ? (
      <FullPageAuthSpinner message="Checking authentication..." />
    ) : (
      <AuthSpinner message="Checking authentication..." />
    );
  }

  if (error) {
    return (
      <div className={className}>
        <AuthErrorDisplay
          error={error}
          onRetry={() => refetch()}
          showCard={true}
        />
      </div>
    );
  }

  if (!isAuthenticated) {
    const loginContent = <LoginForm />;

    if (fullPage) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="w-full max-w-md">{loginContent}</div>
        </div>
      );
    }

    return <div className={className}>{loginContent}</div>;
  }

  return (
    <div className={className}>
      {(showUserProfile || showLogoutButton) && (
        <div className="mb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between">
                <span>Account</span>
                {showLogoutButton && (
                  <LogoutButton variant="outline" size="sm" />
                )}
              </CardTitle>
            </CardHeader>
            {showUserProfile && (
              <CardContent className="pt-0">
                <UserProfile
                  showCard={false}
                  showName={true}
                  showEmail={true}
                  avatarSize="md"
                />
              </CardContent>
            )}
          </Card>
        </div>
      )}
      {children}
    </div>
  );
}

export function ProtectedRoute({
  children,
  fallback,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { authState } = useAuth();
  const { isLoading, isAuthenticated, error } = authState;

  if (isLoading) {
    return <FullPageAuthSpinner message="Authenticating..." />;
  }

  if (error) {
    return (
      fallback || (
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <AuthErrorDisplay error={error} showCard={true} />
          </div>
        </div>
      )
    );
  }

  if (!isAuthenticated) {
    return (
      fallback || (
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <LoginForm />
          </div>
        </div>
      )
    );
  }

  return <>{children}</>;
}

export function PublicRoute({
  children,
  redirectIfAuthenticated = true,
}: {
  children: React.ReactNode;
  redirectIfAuthenticated?: boolean;
}) {
  const { authState } = useAuth();
  const { isLoading, isAuthenticated } = authState;

  if (isLoading) {
    return <FullPageAuthSpinner message="Checking authentication..." />;
  }

  if (isAuthenticated && redirectIfAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-green-600">
              You are already signed in!
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}
