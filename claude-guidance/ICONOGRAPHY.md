# Mini Infra Iconography Guide

**Library**: Tabler Icons (`@tabler/icons-react`) - 5,800+ MIT-licensed icons
**Docs**: https://tabler.io/icons
**Import**: `import { IconName } from "@tabler/icons-react"`

## Icon Reference

### Brand Icons (Use for Technology Logos)
| Icon | Technology | Usage |
|------|-----------|-------|
| `IconBrandDocker` | Docker | Containers, Docker features |
| `IconBrandAzure` | Azure | Blob Storage, Azure services |
| `IconBrandCloudflare` | Cloudflare | Tunnels, CDN, connectivity |
| `IconBrandPostgresql` | PostgreSQL | Database management |

### Navigation Icons
| Icon | Route | Purpose |
|------|-------|---------|
| `IconInnerShadowTop`/`IconAppWindow` | - | App logo (size-5) |
| `IconDashboard` | /dashboard | System overview |
| `IconBrandDocker` | /containers | Container management |
| `IconBrandPostgresql`/`IconDatabase` | /postgres | Database management |
| `IconRocket` | /deployments | Deployment orchestration |
| `IconServer` | /environments | Infrastructure config |
| `IconCloud`/`IconBrandCloudflare` | /tunnels | Cloud connectivity |
| `IconKey` | /api-keys | Credentials |
| `IconNetwork` | /connectivity | Networking |
| `IconSettings` | /settings | Configuration |

### Action Icons
| Icon | Action | Usage |
|------|--------|-------|
| `IconPlus` | Create | Add resources |
| `IconRefresh` | Reload | Refresh data |
| `IconPlayerPlay` | Execute | Start operations |
| `IconTrash` | Delete | Remove items |
| `IconEdit`/`IconPencil` | Modify | Edit config (pick one) |
| `IconDownload` | Export | Download/export |
| `IconArrowLeft`/`Right` | Navigate | Back/forward |
| `IconHome` | Home | Breadcrumbs |
| `IconDots`/`DotsHorizontal` | More | Context menus |
| `IconX` | Close | Dismiss/cancel |
| `IconCopy` | Copy | Clipboard |
| `IconEye`/`IconEyeOff` | Toggle | Show/hide data |

### Status Icons
| Icon | Status | Color/Class |
|------|--------|-------------|
| `IconAlertCircle` | Warning | text-destructive |
| `IconAlertTriangle` | Critical | text-destructive |
| `IconCircleCheck` | Success | text-green-600 |
| `IconCircleX` | Failed | text-red-600 |
| `IconClock` | Timeout | - |
| `IconCheck` | Confirmed | - |
| `IconInfoCircle` | Info | - |
| `IconLoader2`/`IconLoader` | Loading | animate-spin |
| `IconTrendingUp`/`Down` | Trends | - |

### Resource Type Icons
| Icon | Resource | Usage |
|------|----------|-------|
| `IconServer` | Server | Environments |
| `IconDatabase` | Database | DB instances |
| `IconNetwork` | Network | Connectivity |
| `IconDeviceHardDrive` | Storage | Volumes |
| `IconWorld`/`IconGlobe` | Public | Web endpoints |
| `IconKey` | Credential | API keys |
| `IconShield` | Security | Auth/protection |
| `IconBan` | Blocked | Denied access |
| `IconLogin`/`IconLogout` | Auth | User sessions |
| `IconActivity` | Monitor | Real-time activity |
| `IconHistory` | Logs | Historical data |
| `IconBolt` | Performance | Speed/metrics |
| `IconCalendar` | DateTime | Timestamps |

### UI Component Icons
| Icon | Component | Usage |
|------|-----------|-------|
| `IconChevronDown`/`Up` | Dropdown | Expand/collapse |
| `IconChevronsUpDown`/`IconArrowsSort` | Sort | Sortable lists |
| `IconChevronLeft`/`Right` | Pagination | Nav arrows |
| `IconSelector` | Breadcrumb | Separator |
| `IconSearch` | Search | Input fields |
| `IconFilter` | Filter | Controls |
| `IconCircle` | Radio | Radio buttons |
| `IconUser` | Profile | User account |
| `IconDotsVertical` | Menu | Vertical options |

### Testing Icons
| Icon | Test Type | Usage |
|------|-----------|-------|
| `IconCloudQuestion` | Cloud | Azure, Cloudflare validation |
| `IconSettingsQuestion` | Config | Connection strings, endpoints |
| `IconDatabaseSearch` | Database | PostgreSQL connections |
| `IconQuestionMark`/`IconHelpCircle` | Generic | Unknown context |

## Size Guidelines

| Context | Class | Pixels | Usage |
|---------|-------|--------|-------|
| Navigation | *(none)* | 16×16 | Sidebar items |
| Sidebar header | `size-5` | 20×20 | Logo |
| Button | `size-4` | 16×16 | Actions |
| Large action | `size-5` | 20×20 | Prominent buttons |
| Page header | `size-6` | 24×24 | Titles |
| Status badge | `size-4` | 16×16 | Indicators |
| Loader | `size-8` | 32×32 | Loading states |
| Inline | `size-4` | 16×16 | Text inline |

## Quick Rules

1. **Exclusive Use**: Tabler Icons only, no mixing
2. **Brand Priority**: Use `IconBrand*` for specific technologies
3. **Semantic Consistency**: Same icon = same action everywhere
4. **Inherit Colors**: Icons inherit text color by default
5. **Loading**: Always use `animate-spin` with loaders
6. **Accessibility**: Add `aria-label` for icon-only buttons

## Code Patterns

### Navigation (route-config.ts)
```tsx
import { IconBrandDocker, IconDashboard } from "@tabler/icons-react";
'/dashboard': { icon: IconDashboard, title: 'Dashboard' }
```

### Component Actions
```tsx
import { IconPlus, IconTrash, IconLoader2 } from "@tabler/icons-react";

// Create button
<Button><IconPlus className="size-4" />Add</Button>

// Loading state
{isLoading ? (
  <IconLoader2 className="size-4 animate-spin" />
) : (
  <IconPlus className="size-4" />
)}
```

### Status Display
```tsx
// Error
<div className="flex items-center gap-2 text-destructive">
  <IconAlertCircle className="size-4" />
  <span>Failed</span>
</div>

// Success
<div className="flex items-center gap-2 text-green-600">
  <IconCircleCheck className="size-4" />
  <span>Success</span>
</div>
```

### Accessibility
```tsx
// Good
<Button aria-label="Add item"><IconPlus className="size-4" /></Button>

// Better
<Button><IconPlus className="size-4" /><span>Add</span></Button>
```

## Adding New Icons

1. Check existing icons first
2. Search at https://tabler.io/icons
3. Prefer brand icons for technologies
4. Use `Icon` prefix (e.g., `IconDatabase`)
5. Follow size guidelines
6. Update this guide

---

**Last Updated**: 2025-01-09
