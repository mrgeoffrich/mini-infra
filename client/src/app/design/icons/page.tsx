import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search } from "lucide-react";
import { IconCard } from "./IconCard";

// Import all icons from Lucide React
import {
  // Navigation icons
  LayoutDashboard,
  Container,
  Database,
  Rocket,
  Server,
  Cloud,
  CloudCog,
  Key,
  Network,
  Settings,
  Boxes,
  // Action and UI icons
  Plus,
  RefreshCw,
  Play,
  Trash2,
  Edit,
  Pencil,
  Download,
  ArrowLeft,
  ArrowRight,
  Home,
  MoreHorizontal,
  X,
  Copy,
  Eye,
  EyeOff,
  AlertCircle,
  AlertTriangle,
  CheckIcon,
  CheckCircle,
  XCircle,
  Clock,
  Info,
  Loader2,
  TrendingUp,
  TrendingDown,
  HardDrive,
  Globe,
  Shield,
  Ban,
  LogIn,
  LogOut,
  Activity,
  History,
  Zap,
  Calendar,
  ChevronDown,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown,
  Filter,
  CircleIcon,
  XIcon,
  User,
  TestTube,
  MoreVertical,
} from "lucide-react";

interface IconDefinition {
  name: string;
  component: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  library: "lucide";
  usage: string;
  importPath: string;
  sizes?: string[];
}

const navigationIcons: IconDefinition[] = [
  {
    name: "Boxes",
    component: Boxes,
    library: "lucide",
    usage: "Application logo and brand mark",
    importPath: 'import { Boxes } from "lucide-react"',
    sizes: ["!size-5"],
  },
  {
    name: "LayoutDashboard",
    component: LayoutDashboard,
    library: "lucide",
    usage: "Dashboard / Overview",
    importPath: 'import { LayoutDashboard } from "lucide-react"',
  },
  {
    name: "Container",
    component: Container,
    library: "lucide",
    usage: "Docker Containers (Docker whale icon)",
    importPath: 'import { Container } from "lucide-react"',
  },
  {
    name: "Database",
    component: Database,
    library: "lucide",
    usage: "PostgreSQL / Database",
    importPath: 'import { Database } from "lucide-react"',
  },
  {
    name: "Rocket",
    component: Rocket,
    library: "lucide",
    usage: "Deployments",
    importPath: 'import { Rocket } from "lucide-react"',
  },
  {
    name: "Server",
    component: Server,
    library: "lucide",
    usage: "Environments",
    importPath: 'import { Server } from "lucide-react"',
  },
  {
    name: "Cloud",
    component: Cloud,
    library: "lucide",
    usage: "Cloudflare Tunnels / Cloud Services / Azure",
    importPath: 'import { Cloud } from "lucide-react"',
  },
  {
    name: "CloudCog",
    component: CloudCog,
    library: "lucide",
    usage: "Cloudflare Settings (sub-navigation)",
    importPath: 'import { CloudCog } from "lucide-react"',
  },
  {
    name: "Key",
    component: Key,
    library: "lucide",
    usage: "API Keys / Credentials",
    importPath: 'import { Key } from "lucide-react"',
  },
  {
    name: "Network",
    component: Network,
    library: "lucide",
    usage: "Connectivity / Networking",
    importPath: 'import { Network } from "lucide-react"',
  },
  {
    name: "Settings",
    component: Settings,
    library: "lucide",
    usage: "Settings",
    importPath: 'import { Settings } from "lucide-react"',
  },
];

const actionIcons: IconDefinition[] = [
  {
    name: "Plus",
    component: Plus,
    library: "lucide",
    usage: "Add / Create new resource",
    importPath: 'import { Plus } from "lucide-react"',
    sizes: ["h-4 w-4", "h-5 w-5"],
  },
  {
    name: "RefreshCw",
    component: RefreshCw,
    library: "lucide",
    usage: "Refresh / Reload data",
    importPath: 'import { RefreshCw } from "lucide-react"',
    sizes: ["h-4 w-4", "h-5 w-5"],
  },
  {
    name: "Play",
    component: Play,
    library: "lucide",
    usage: "Execute / Start operation",
    importPath: 'import { Play } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Trash2",
    component: Trash2,
    library: "lucide",
    usage: "Delete / Remove",
    importPath: 'import { Trash2 } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Edit",
    component: Edit,
    library: "lucide",
    usage: "Edit / Modify",
    importPath: 'import { Edit } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Pencil",
    component: Pencil,
    library: "lucide",
    usage: "Edit / Modify (alternative)",
    importPath: 'import { Pencil } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Download",
    component: Download,
    library: "lucide",
    usage: "Download / Export",
    importPath: 'import { Download } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "ArrowLeft",
    component: ArrowLeft,
    library: "lucide",
    usage: "Back / Return",
    importPath: 'import { ArrowLeft } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "ArrowRight",
    component: ArrowRight,
    library: "lucide",
    usage: "Forward / Next step",
    importPath: 'import { ArrowRight } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Home",
    component: Home,
    library: "lucide",
    usage: "Navigate to home/dashboard",
    importPath: 'import { Home } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "MoreHorizontal",
    component: MoreHorizontal,
    library: "lucide",
    usage: "More options / Context menu",
    importPath: 'import { MoreHorizontal } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "X",
    component: X,
    library: "lucide",
    usage: "Close / Cancel / Clear",
    importPath: 'import { X } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Copy",
    component: Copy,
    library: "lucide",
    usage: "Copy to clipboard",
    importPath: 'import { Copy } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Eye",
    component: Eye,
    library: "lucide",
    usage: "Show sensitive data",
    importPath: 'import { Eye } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "EyeOff",
    component: EyeOff,
    library: "lucide",
    usage: "Hide sensitive data",
    importPath: 'import { EyeOff } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
];

const statusIcons: IconDefinition[] = [
  {
    name: "CheckCircle",
    component: CheckCircle,
    library: "lucide",
    usage: "Connected / Success status (site header connectivity)",
    importPath: 'import { CheckCircle } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "XCircle",
    component: XCircle,
    library: "lucide",
    usage: "Failed / Disconnected status (site header connectivity)",
    importPath: 'import { XCircle } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Clock",
    component: Clock,
    library: "lucide",
    usage: "Timeout status (site header connectivity)",
    importPath: 'import { Clock } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "AlertCircle",
    component: AlertCircle,
    library: "lucide",
    usage: "Warning / Attention needed / Unreachable status",
    importPath: 'import { AlertCircle } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "AlertTriangle",
    component: AlertTriangle,
    library: "lucide",
    usage: "Critical alert / Danger",
    importPath: 'import { AlertTriangle } from "lucide-react"',
    sizes: ["h-4 w-4", "h-6 w-6"],
  },
  {
    name: "Check",
    component: CheckIcon,
    library: "lucide",
    usage: "Success / Confirmed",
    importPath: 'import { Check, CheckIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Info",
    component: Info,
    library: "lucide",
    usage: "Information / Help",
    importPath: 'import { Info } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Loader2",
    component: Loader2,
    library: "lucide",
    usage: "Loading / Processing (with spin animation)",
    importPath: 'import { Loader2 } from "lucide-react"',
    sizes: ["h-4 w-4 animate-spin", "h-8 w-8 animate-spin"],
  },
  {
    name: "TrendingUp",
    component: TrendingUp,
    library: "lucide",
    usage: "Positive trend / Increase / Growth indicator",
    importPath: 'import { TrendingUp } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "TrendingDown",
    component: TrendingDown,
    library: "lucide",
    usage: "Negative trend / Decrease",
    importPath: 'import { TrendingDown } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
];

const resourceIcons: IconDefinition[] = [
  {
    name: "Server",
    component: Server,
    library: "lucide",
    usage: "Physical/virtual server, environment",
    importPath: 'import { Server } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Container",
    component: Container,
    library: "lucide",
    usage: "Docker container",
    importPath: 'import { Container } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Database",
    component: Database,
    library: "lucide",
    usage: "Database instance",
    importPath: 'import { Database } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "HardDrive",
    component: HardDrive,
    library: "lucide",
    usage: "Storage volume",
    importPath: 'import { HardDrive } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Globe",
    component: Globe,
    library: "lucide",
    usage: "Public endpoint, web access",
    importPath: 'import { Globe } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Shield",
    component: Shield,
    library: "lucide",
    usage: "Security, protection, authentication",
    importPath: 'import { Shield } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Ban",
    component: Ban,
    library: "lucide",
    usage: "Blocked, denied access",
    importPath: 'import { Ban } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "LogIn",
    component: LogIn,
    library: "lucide",
    usage: "Login action",
    importPath: 'import { LogIn } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "LogOut",
    component: LogOut,
    library: "lucide",
    usage: "Logout action",
    importPath: 'import { LogOut } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Activity",
    component: Activity,
    library: "lucide",
    usage: "Real-time activity, monitoring",
    importPath: 'import { Activity } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "History",
    component: History,
    library: "lucide",
    usage: "Historical data, logs",
    importPath: 'import { History } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Zap",
    component: Zap,
    library: "lucide",
    usage: "Fast operation, performance",
    importPath: 'import { Zap } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Calendar",
    component: Calendar,
    library: "lucide",
    usage: "Date/time information",
    importPath: 'import { Calendar } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
];

const uiComponentIcons: IconDefinition[] = [
  {
    name: "ChevronDown",
    component: ChevronDown,
    library: "lucide",
    usage: "Expand dropdown",
    importPath: 'import { ChevronDown, ChevronDownIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "ChevronsUpDown",
    component: ChevronsUpDown,
    library: "lucide",
    usage: "Combo box, sortable",
    importPath: 'import { ChevronsUpDown, ChevronsUpDownIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "ChevronLeft",
    component: ChevronLeft,
    library: "lucide",
    usage: "Pagination, navigation left",
    importPath: 'import { ChevronLeft } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "ChevronRight",
    component: ChevronRight,
    library: "lucide",
    usage: "Pagination, navigation right",
    importPath: 'import { ChevronRight, ChevronRightIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "ArrowUpDown",
    component: ArrowUpDown,
    library: "lucide",
    usage: "Sortable column",
    importPath: 'import { ArrowUpDown } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Search",
    component: Search,
    library: "lucide",
    usage: "Search input",
    importPath: 'import { Search, SearchIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "Filter",
    component: Filter,
    library: "lucide",
    usage: "Filter controls",
    importPath: 'import { Filter } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "CircleIcon",
    component: CircleIcon,
    library: "lucide",
    usage: "Radio button indicator",
    importPath: 'import { CircleIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "XIcon",
    component: XIcon,
    library: "lucide",
    usage: "Close dialog, remove item",
    importPath: 'import { XIcon } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "User",
    component: User,
    library: "lucide",
    usage: "User profile, account",
    importPath: 'import { User } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
  {
    name: "MoreVertical",
    component: MoreVertical,
    library: "lucide",
    usage: "User menu, more options (vertical)",
    importPath: 'import { MoreVertical } from "lucide-react"',
    sizes: ["h-4 w-4"],
  },
];

const utilityIcons: IconDefinition[] = [
  {
    name: "TestTube",
    component: TestTube,
    library: "lucide",
    usage: "Test connection, validation",
    importPath: 'import { TestTube } from "lucide-react"',
    sizes: ["h-4 w-4"],
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
          Visual reference for the Mini Infra iconography system using Lucide React
        </p>

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search icons by name or usage..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      <div className="px-4 lg:px-6">
        <Tabs defaultValue="navigation" className="w-full">
          <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6">
            <TabsTrigger value="navigation">Navigation</TabsTrigger>
            <TabsTrigger value="actions">Actions</TabsTrigger>
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="resources">Resources</TabsTrigger>
            <TabsTrigger value="ui">UI Components</TabsTrigger>
            <TabsTrigger value="utility">Utility</TabsTrigger>
          </TabsList>

          <TabsContent value="navigation" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Navigation Icons</CardTitle>
                <CardDescription>
                  Lucide icons used for navigation, branding, and major feature representation
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
                  Lucide icons for primary and secondary actions throughout the application
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
                <CardTitle>Testing & Utility Icons</CardTitle>
                <CardDescription>
                  Icons for testing, validation, and utility functions
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filterIcons(utilityIcons).map((icon) => (
                    <IconCard
                      key={icon.name}
                      icon={icon}
                      onCopy={copyToClipboard}
                      isCopied={copiedImport === icon.name}
                    />
                  ))}
                </div>
                {filterIcons(utilityIcons).length === 0 && (
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
