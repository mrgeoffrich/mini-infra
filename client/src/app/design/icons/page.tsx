import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IconSearch } from "@tabler/icons-react";
import type { Icon } from "@tabler/icons-react";
import { IconCard } from "./IconCard";

// Import brand icons
import {
  IconBrandDocker,
  IconBrandAzure,
  IconBrandCloudflare,
} from "@tabler/icons-react";

// Import navigation icons
import {
  IconInnerShadowTop,
  IconAppWindow,
  IconDashboard,
  IconDatabase,
  IconRocket,
  IconServer,
  IconCloud,
  IconCloudComputing,
  IconKey,
  IconNetwork,
  IconSettings,
} from "@tabler/icons-react";

// Import action icons
import {
  IconPlus,
  IconRefresh,
  IconPlayerPlay,
  IconTrash,
  IconEdit,
  IconPencil,
  IconDownload,
  IconArrowLeft,
  IconArrowRight,
  IconHome,
  IconDots,
  IconDotsVertical,
  IconX,
  IconCopy,
  IconEye,
  IconEyeOff,
} from "@tabler/icons-react";

// Import status icons
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconCheck,
  IconInfoCircle,
  IconLoader2,
  IconLoader,
  IconTrendingUp,
  IconTrendingDown,
} from "@tabler/icons-react";

// Import resource icons
import {
  IconServer2,
  IconWorld,
  IconGlobe,
  IconShield,
  IconBan,
  IconLogin,
  IconLogout,
  IconActivity,
  IconHistory,
  IconBolt,
  IconCalendar,
} from "@tabler/icons-react";

// Import UI component icons
import {
  IconChevronDown,
  IconChevronUp,
  IconChevronsDown,
  IconChevronsUp,
  IconArrowsSort,
  IconChevronLeft,
  IconChevronRight,
  IconSelector,
  IconFilter,
  IconCircle,
  IconUser,
} from "@tabler/icons-react";

// Import testing & validation icons
import {
  IconCloudQuestion,
  IconSettingsQuestion,
  IconDatabaseSearch,
  IconQuestionMark,
  IconHelpCircle,
} from "@tabler/icons-react";

interface IconDefinition {
  name: string;
  component: Icon;
  library: "tabler";
  usage: string;
  importPath: string;
  sizes?: string[];
  isBrand?: boolean;
}

const brandIcons: IconDefinition[] = [
  {
    name: "IconBrandDocker",
    component: IconBrandDocker,
    library: "tabler",
    usage: "Docker containers and containerization - Official Docker whale logo",
    importPath: 'import { IconBrandDocker } from "@tabler/icons-react"',
    sizes: ["size-4", "size-6"],
    isBrand: true,
  },
  {
    name: "IconBrandAzure",
    component: IconBrandAzure,
    library: "tabler",
    usage: "Microsoft Azure cloud services - Official Microsoft Azure logo",
    importPath: 'import { IconBrandAzure } from "@tabler/icons-react"',
    sizes: ["size-4", "size-6"],
    isBrand: true,
  },
  {
    name: "IconBrandCloudflare",
    component: IconBrandCloudflare,
    library: "tabler",
    usage: "Cloudflare services, tunnels, CDN - Official Cloudflare logo",
    importPath: 'import { IconBrandCloudflare } from "@tabler/icons-react"',
    sizes: ["size-4", "size-6"],
    isBrand: true,
  },
];

const navigationIcons: IconDefinition[] = [
  {
    name: "IconInnerShadowTop",
    component: IconInnerShadowTop,
    library: "tabler",
    usage: "Application logo and brand mark",
    importPath: 'import { IconInnerShadowTop } from "@tabler/icons-react"',
    sizes: ["size-5"],
  },
  {
    name: "IconAppWindow",
    component: IconAppWindow,
    library: "tabler",
    usage: "Application logo alternative",
    importPath: 'import { IconAppWindow } from "@tabler/icons-react"',
    sizes: ["size-5"],
  },
  {
    name: "IconDashboard",
    component: IconDashboard,
    library: "tabler",
    usage: "Dashboard / System Overview",
    importPath: 'import { IconDashboard } from "@tabler/icons-react"',
  },
  {
    name: "IconBrandDocker",
    component: IconBrandDocker,
    library: "tabler",
    usage: "Docker Containers (Brand Icon - Use in navigation)",
    importPath: 'import { IconBrandDocker } from "@tabler/icons-react"',
    isBrand: true,
  },
  {
    name: "IconDatabase",
    component: IconDatabase,
    library: "tabler",
    usage: "Database / PostgreSQL (generic database icon)",
    importPath: 'import { IconDatabase } from "@tabler/icons-react"',
  },
  {
    name: "IconRocket",
    component: IconRocket,
    library: "tabler",
    usage: "Deployments",
    importPath: 'import { IconRocket } from "@tabler/icons-react"',
  },
  {
    name: "IconServer",
    component: IconServer,
    library: "tabler",
    usage: "Environments / Infrastructure",
    importPath: 'import { IconServer } from "@tabler/icons-react"',
  },
  {
    name: "IconCloud",
    component: IconCloud,
    library: "tabler",
    usage: "Cloud Services / Generic cloud",
    importPath: 'import { IconCloud } from "@tabler/icons-react"',
  },
  {
    name: "IconBrandCloudflare",
    component: IconBrandCloudflare,
    library: "tabler",
    usage: "Cloudflare Tunnels (Brand Icon - Use for Cloudflare pages)",
    importPath: 'import { IconBrandCloudflare } from "@tabler/icons-react"',
    isBrand: true,
  },
  {
    name: "IconCloudComputing",
    component: IconCloudComputing,
    library: "tabler",
    usage: "Cloud Settings / Configuration",
    importPath: 'import { IconCloudComputing } from "@tabler/icons-react"',
  },
  {
    name: "IconKey",
    component: IconKey,
    library: "tabler",
    usage: "API Keys / Credentials",
    importPath: 'import { IconKey } from "@tabler/icons-react"',
  },
  {
    name: "IconNetwork",
    component: IconNetwork,
    library: "tabler",
    usage: "Connectivity / Networking",
    importPath: 'import { IconNetwork } from "@tabler/icons-react"',
  },
  {
    name: "IconSettings",
    component: IconSettings,
    library: "tabler",
    usage: "Settings / Configuration",
    importPath: 'import { IconSettings } from "@tabler/icons-react"',
  },
];

const actionIcons: IconDefinition[] = [
  {
    name: "IconPlus",
    component: IconPlus,
    library: "tabler",
    usage: "Add / Create new resource",
    importPath: 'import { IconPlus } from "@tabler/icons-react"',
    sizes: ["size-4", "size-5"],
  },
  {
    name: "IconRefresh",
    component: IconRefresh,
    library: "tabler",
    usage: "Refresh / Reload data",
    importPath: 'import { IconRefresh } from "@tabler/icons-react"',
    sizes: ["size-4", "size-5"],
  },
  {
    name: "IconPlayerPlay",
    component: IconPlayerPlay,
    library: "tabler",
    usage: "Execute / Start operation",
    importPath: 'import { IconPlayerPlay } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconTrash",
    component: IconTrash,
    library: "tabler",
    usage: "Delete / Remove",
    importPath: 'import { IconTrash } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconEdit",
    component: IconEdit,
    library: "tabler",
    usage: "Edit / Modify",
    importPath: 'import { IconEdit } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconPencil",
    component: IconPencil,
    library: "tabler",
    usage: "Edit / Modify (alternative)",
    importPath: 'import { IconPencil } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconDownload",
    component: IconDownload,
    library: "tabler",
    usage: "Download / Export",
    importPath: 'import { IconDownload } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconArrowLeft",
    component: IconArrowLeft,
    library: "tabler",
    usage: "Back / Return",
    importPath: 'import { IconArrowLeft } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconArrowRight",
    component: IconArrowRight,
    library: "tabler",
    usage: "Forward / Next step",
    importPath: 'import { IconArrowRight } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconHome",
    component: IconHome,
    library: "tabler",
    usage: "Navigate to home/dashboard",
    importPath: 'import { IconHome } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconDots",
    component: IconDots,
    library: "tabler",
    usage: "More options / Context menu",
    importPath: 'import { IconDots } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconDotsVertical",
    component: IconDotsVertical,
    library: "tabler",
    usage: "More options / User menu (vertical)",
    importPath: 'import { IconDotsVertical } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconX",
    component: IconX,
    library: "tabler",
    usage: "Close / Cancel / Clear",
    importPath: 'import { IconX } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconCopy",
    component: IconCopy,
    library: "tabler",
    usage: "Copy to clipboard",
    importPath: 'import { IconCopy } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconEye",
    component: IconEye,
    library: "tabler",
    usage: "Show sensitive data",
    importPath: 'import { IconEye } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconEyeOff",
    component: IconEyeOff,
    library: "tabler",
    usage: "Hide sensitive data",
    importPath: 'import { IconEyeOff } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
];

const statusIcons: IconDefinition[] = [
  {
    name: "IconCircleCheck",
    component: IconCircleCheck,
    library: "tabler",
    usage: "Connected / Success status",
    importPath: 'import { IconCircleCheck } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconCircleX",
    component: IconCircleX,
    library: "tabler",
    usage: "Failed / Disconnected status",
    importPath: 'import { IconCircleX } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconClock",
    component: IconClock,
    library: "tabler",
    usage: "Timeout / Pending status",
    importPath: 'import { IconClock } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconAlertCircle",
    component: IconAlertCircle,
    library: "tabler",
    usage: "Warning / Attention needed / Unreachable",
    importPath: 'import { IconAlertCircle } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconAlertTriangle",
    component: IconAlertTriangle,
    library: "tabler",
    usage: "Critical alert / Danger",
    importPath: 'import { IconAlertTriangle } from "@tabler/icons-react"',
    sizes: ["size-4", "size-6"],
  },
  {
    name: "IconCheck",
    component: IconCheck,
    library: "tabler",
    usage: "Success / Confirmed / Checkbox",
    importPath: 'import { IconCheck } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconInfoCircle",
    component: IconInfoCircle,
    library: "tabler",
    usage: "Information / Help",
    importPath: 'import { IconInfoCircle } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconLoader2",
    component: IconLoader2,
    library: "tabler",
    usage: "Loading / Processing (with spin animation)",
    importPath: 'import { IconLoader2 } from "@tabler/icons-react"',
    sizes: ["size-4 animate-spin", "size-8 animate-spin"],
  },
  {
    name: "IconLoader",
    component: IconLoader,
    library: "tabler",
    usage: "Loading / Processing (alternative)",
    importPath: 'import { IconLoader } from "@tabler/icons-react"',
    sizes: ["size-4 animate-spin", "size-8 animate-spin"],
  },
  {
    name: "IconTrendingUp",
    component: IconTrendingUp,
    library: "tabler",
    usage: "Positive trend / Increase / Growth",
    importPath: 'import { IconTrendingUp } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconTrendingDown",
    component: IconTrendingDown,
    library: "tabler",
    usage: "Negative trend / Decrease",
    importPath: 'import { IconTrendingDown } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
];

const resourceIcons: IconDefinition[] = [
  {
    name: "IconServer",
    component: IconServer,
    library: "tabler",
    usage: "Physical/virtual server, environment",
    importPath: 'import { IconServer } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconServer2",
    component: IconServer2,
    library: "tabler",
    usage: "Storage volume / Secondary server",
    importPath: 'import { IconServer2 } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconBrandDocker",
    component: IconBrandDocker,
    library: "tabler",
    usage: "Docker container (Brand Icon)",
    importPath: 'import { IconBrandDocker } from "@tabler/icons-react"',
    sizes: ["size-4"],
    isBrand: true,
  },
  {
    name: "IconDatabase",
    component: IconDatabase,
    library: "tabler",
    usage: "Database instance (generic)",
    importPath: 'import { IconDatabase } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconWorld",
    component: IconWorld,
    library: "tabler",
    usage: "Public endpoint, web access",
    importPath: 'import { IconWorld } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconGlobe",
    component: IconGlobe,
    library: "tabler",
    usage: "Public endpoint (alternative)",
    importPath: 'import { IconGlobe } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconShield",
    component: IconShield,
    library: "tabler",
    usage: "Security, protection, authentication",
    importPath: 'import { IconShield } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconBan",
    component: IconBan,
    library: "tabler",
    usage: "Blocked, denied access",
    importPath: 'import { IconBan } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconLogin",
    component: IconLogin,
    library: "tabler",
    usage: "Login action",
    importPath: 'import { IconLogin } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconLogout",
    component: IconLogout,
    library: "tabler",
    usage: "Logout action",
    importPath: 'import { IconLogout } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconActivity",
    component: IconActivity,
    library: "tabler",
    usage: "Real-time activity, monitoring",
    importPath: 'import { IconActivity } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconHistory",
    component: IconHistory,
    library: "tabler",
    usage: "Historical data, logs",
    importPath: 'import { IconHistory } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconBolt",
    component: IconBolt,
    library: "tabler",
    usage: "Fast operation, performance",
    importPath: 'import { IconBolt } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconCalendar",
    component: IconCalendar,
    library: "tabler",
    usage: "Date/time information",
    importPath: 'import { IconCalendar } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
];

const uiComponentIcons: IconDefinition[] = [
  {
    name: "IconChevronDown",
    component: IconChevronDown,
    library: "tabler",
    usage: "Expand dropdown",
    importPath: 'import { IconChevronDown } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconChevronUp",
    component: IconChevronUp,
    library: "tabler",
    usage: "Collapse dropdown",
    importPath: 'import { IconChevronUp } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconChevronsDown",
    component: IconChevronsDown,
    library: "tabler",
    usage: "Combo box / Collapse all",
    importPath: 'import { IconChevronsDown } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconChevronsUp",
    component: IconChevronsUp,
    library: "tabler",
    usage: "Combo box / Expand all",
    importPath: 'import { IconChevronsUp } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconArrowsSort",
    component: IconArrowsSort,
    library: "tabler",
    usage: "Sortable column",
    importPath: 'import { IconArrowsSort } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconChevronLeft",
    component: IconChevronLeft,
    library: "tabler",
    usage: "Pagination left, navigation",
    importPath: 'import { IconChevronLeft } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconChevronRight",
    component: IconChevronRight,
    library: "tabler",
    usage: "Pagination right, navigation",
    importPath: 'import { IconChevronRight } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconSelector",
    component: IconSelector,
    library: "tabler",
    usage: "Breadcrumb separator, submenu",
    importPath: 'import { IconSelector } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconSearch",
    component: IconSearch,
    library: "tabler",
    usage: "Search input",
    importPath: 'import { IconSearch } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconFilter",
    component: IconFilter,
    library: "tabler",
    usage: "Filter controls",
    importPath: 'import { IconFilter } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconCircle",
    component: IconCircle,
    library: "tabler",
    usage: "Radio button indicator",
    importPath: 'import { IconCircle } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconUser",
    component: IconUser,
    library: "tabler",
    usage: "User profile, account",
    importPath: 'import { IconUser } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
];

const testingIcons: IconDefinition[] = [
  {
    name: "IconCloudQuestion",
    component: IconCloudQuestion,
    library: "tabler",
    usage: "Test cloud service connections (Azure, Cloudflare)",
    importPath: 'import { IconCloudQuestion } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconSettingsQuestion",
    component: IconSettingsQuestion,
    library: "tabler",
    usage: "Test configuration settings, connection strings",
    importPath: 'import { IconSettingsQuestion } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconDatabaseSearch",
    component: IconDatabaseSearch,
    library: "tabler",
    usage: "Test database connections (PostgreSQL)",
    importPath: 'import { IconDatabaseSearch } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconQuestionMark",
    component: IconQuestionMark,
    library: "tabler",
    usage: "Generic testing/validation",
    importPath: 'import { IconQuestionMark } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
  {
    name: "IconHelpCircle",
    component: IconHelpCircle,
    library: "tabler",
    usage: "Generic validation (alternative)",
    importPath: 'import { IconHelpCircle } from "@tabler/icons-react"',
    sizes: ["size-4"],
  },
];

export function IconShowcasePage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedImport, setCopiedImport] = useState<string | null>(null);

  const filterIcons = (icons: IconDefinition[]) => {
    if (!searchQuery) return icons;
    const query = searchQuery.toLowerCase();
    return icons.filter(
      (icon) =>
        icon.name.toLowerCase().includes(query) ||
        icon.usage.toLowerCase().includes(query)
    );
  };

  const copyToClipboard = (text: string, iconName: string) => {
    navigator.clipboard.writeText(text);
    setCopiedImport(iconName);
    setTimeout(() => setCopiedImport(null), 2000);
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-3xl font-bold">Icon Reference</h1>
          <Badge variant="outline" className="text-xs">
            Development Only
          </Badge>
        </div>
        <p className="text-muted-foreground mb-6">
          Visual reference for the Mini Infra iconography system using Tabler Icons exclusively.
          Features 5,800+ icons including comprehensive brand logos for infrastructure services.
        </p>

        <div className="relative mb-6">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search icons by name or usage..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <Tabs defaultValue="brand" className="w-full">
          <TabsList className="grid w-full grid-cols-4 lg:grid-cols-7">
            <TabsTrigger value="brand">Brand ⭐</TabsTrigger>
            <TabsTrigger value="navigation">Navigation</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="resources">Resources</TabsTrigger>
            <TabsTrigger value="ui">UI</TabsTrigger>
            <TabsTrigger value="utility">Utility</TabsTrigger>
          </TabsList>

          <TabsContent value="brand" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Brand Icons ⭐ NEW</CardTitle>
                <CardDescription>
                  Official brand logos for infrastructure services and technologies. Use these for better recognition and professional appearance.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(brandIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(brandIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="navigation" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Navigation Icons</CardTitle>
                <CardDescription>
                  Tabler icons used for navigation, branding, and major feature representation
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(navigationIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(navigationIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="actions" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Action Icons</CardTitle>
                <CardDescription>
                  Tabler icons for primary and secondary actions throughout the application
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(actionIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(actionIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="status" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Status & Indicator Icons</CardTitle>
                <CardDescription>
                  Visual feedback and state indicators for user interface
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(statusIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(statusIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="resources" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Resource Type Icons</CardTitle>
                <CardDescription>
                  Icons representing infrastructure resources, security, and data
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(resourceIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(resourceIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ui" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>UI Component Icons</CardTitle>
                <CardDescription>
                  Icons used within UI components, dropdowns, and controls
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(uiComponentIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(uiComponentIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="utility" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Testing & Validation Icons</CardTitle>
                <CardDescription>
                  Context-specific question icons for testing connections and validating configurations.
                  Choose the icon that matches what you're testing (cloud, settings, database, etc.)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(testingIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(testingIcons).length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No icons found matching "{searchQuery}"
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
