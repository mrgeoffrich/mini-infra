# Page Layout Design Guide (Condensed)

Standard layout pattern for settings/management pages based on Registry Credentials and Self-Backup pages.

## Core Pattern

**Container**: `flex flex-col gap-4 py-4 md:gap-6 md:py-6`
**Horizontal padding**: `px-4 lg:px-6`
**Content width**: `max-w-7xl` (omit for full-width tables)

## Header Structure

```tsx
<div className="px-4 lg:px-6">
  <div className="flex items-center gap-3">
    <div className="p-3 rounded-md bg-{color}-100 text-{color}-800 dark:bg-{color}-900 dark:text-{color}-300">
      <IconName className="h-6 w-6" />
    </div>
    <div>
      <h1 className="text-3xl font-bold">Page Title</h1>
      <p className="text-muted-foreground">Brief description</p>
    </div>
  </div>
</div>
```

**Icon colors**: blue | orange | green | purple | red

**Header with action button**: Add `justify-between` to inner div, button with `Plus` icon (`h-4 w-4 mr-2`)

## Content Sections

```tsx
<div className="px-4 lg:px-6 max-w-7xl">
  <Card>
    <CardHeader>
      <CardTitle>Section Title</CardTitle>
      <CardDescription>Description</CardDescription>
    </CardHeader>
    <CardContent>{/* content */}</CardContent>
  </Card>
</div>
```

## State Patterns

### Loading
```tsx
<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
  <div className="px-4 lg:px-6">
    <div className="flex items-center gap-3">
      <Skeleton className="h-12 w-12 rounded-md" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
    </div>
  </div>
  <div className="px-4 lg:px-6 max-w-7xl">
    <Skeleton className="h-[400px] w-full" />
  </div>
</div>
```

### Error
Same header structure as loading, add after header:
```tsx
<Alert variant="destructive">
  <AlertCircle className="h-4 w-4" />
  <AlertDescription>Failed to load data. Please try refreshing.</AlertDescription>
</Alert>
```

## Design Tokens

### Typography
- Page title: `text-3xl font-bold`
- Description: `text-muted-foreground`
- Section labels: `text-sm font-medium`

### Icons
- Header: `h-6 w-6` in `p-3 rounded-md` colored box
- Buttons: `h-4 w-4 mr-2`
- Status: `h-4 w-4` inline

### Spacing
- Outer gap: `gap-4 py-4 md:gap-6 md:py-6`
- Horizontal: `px-4 lg:px-6`
- Icon-title: `gap-3`
- Forms: `space-y-4` or `space-y-6`

### Responsive
- Mobile: `gap-4 py-4 px-4`
- Desktop: `gap-6 py-6 lg:px-6`

## Examples

- **Registry Credentials** (`settings/registry-credentials/page.tsx`): Orange/Key, action button, table, max-w-7xl
- **Self-Backup** (`settings/self-backup/page.tsx`): Blue/Database, form card, history table, max-w-7xl
- **Container Dashboard** (`containers/ContainerDashboard.tsx`): Blue/Container, full-width table, no max-w-7xl

## Migration Checklist

- [ ] Outer container: `flex flex-col gap-4 py-4 md:gap-6 md:py-6`
- [ ] Header: `px-4 lg:px-6` with icon box pattern (`h-6 w-6`)
- [ ] Remove header margins (controlled by outer gap)
- [ ] Content sections: `px-4 lg:px-6` + `max-w-7xl` (if needed)
- [ ] Match loading/error state structure
- [ ] Test responsive & dark mode

## Rules

✅ DO:
- Use `flex flex-col` with responsive gaps (not `container`)
- Consistent `h-6 w-6` header icons
- Let outer `gap` control spacing (no margins on sections)
- Use `gap` for flex, `space-y` for stacked content
- Include `dark:` variants for all colors
- Consider content type for width (tables=full, forms=constrained)

❌ DON'T:
- Mix `space-y` with `gap` on same element
- Add margins to header/sections
- Use different icon sizes per page
- Forget dark mode variants
- Always use `max-w-7xl` without considering content
