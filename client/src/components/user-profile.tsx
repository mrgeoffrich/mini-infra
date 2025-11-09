import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/hooks/use-user";
import { IconUser } from "@tabler/icons-react";

interface UserProfileProps {
  showCard?: boolean;
  showName?: boolean;
  showEmail?: boolean;
  avatarSize?: "sm" | "md" | "lg";
  className?: string;
}

export function UserProfile({
  showCard = true,
  showName = true,
  showEmail = true,
  avatarSize = "md",
  className = "",
}: UserProfileProps) {
  const { user, isLoading, isAuthenticated } = useUser();

  if (isLoading) {
    return <UserProfileSkeleton showCard={showCard} avatarSize={avatarSize} />;
  }

  if (!isAuthenticated || !user) {
    return null;
  }

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const avatarSizeClasses = {
    sm: "h-8 w-8 text-sm",
    md: "h-10 w-10 text-base",
    lg: "h-12 w-12 text-lg",
  };

  const profileContent = (
    <div className={`flex items-center gap-3 ${className}`}>
      <Avatar className={avatarSizeClasses[avatarSize]}>
        <AvatarImage
          src={user.image || undefined}
          alt={user.name || user.email}
        />
        <AvatarFallback>
          {user.name ? getInitials(user.name) : <IconUser className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col justify-center min-w-0 flex-1">
        {showName && user.name && (
          <div className="text-sm font-medium leading-none truncate">
            {user.name}
          </div>
        )}
        {showEmail && (
          <div className="text-xs text-muted-foreground truncate mt-1">
            {user.email}
          </div>
        )}
      </div>
    </div>
  );

  if (!showCard) {
    return profileContent;
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="text-sm font-medium">User Profile</div>
      </CardHeader>
      <CardContent className="pt-0">{profileContent}</CardContent>
    </Card>
  );
}

function UserProfileSkeleton({
  showCard,
  avatarSize,
}: {
  showCard: boolean;
  avatarSize: "sm" | "md" | "lg";
}) {
  const avatarSizeClasses = {
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-12 w-12",
  };

  const skeletonContent = (
    <div className="flex items-center gap-3">
      <Skeleton className={`rounded-full ${avatarSizeClasses[avatarSize]}`} />
      <div className="flex flex-col gap-2 flex-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );

  if (!showCard) {
    return skeletonContent;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <Skeleton className="h-4 w-20" />
      </CardHeader>
      <CardContent className="pt-0">{skeletonContent}</CardContent>
    </Card>
  );
}
