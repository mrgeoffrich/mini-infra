# Page Layout Design Guide

This document outlines the standard layout pattern for settings and management pages in the Mini Infra application.

## Overview

All settings and management pages should follow a consistent layout structure for visual cohesion and user experience. This pattern is based on the Registry Credentials and Self-Backup pages.

## Layout Structure

### Main Container

```tsx
<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
  {/* Page content */}
</div>
```

**Purpose**:
- Provides responsive vertical spacing between sections
- `gap-4 py-4` on mobile, `gap-6 py-6` on desktop
- Uses flexbox for predictable spacing

### Header Section

```tsx
<div className="px-4 lg:px-6">
  <div className="flex items-center gap-3">
    {/* Icon with colored background */}
    <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
      <IconName className="h-6 w-6" />
    </div>

    {/* Title and description */}
    <div>
      <h1 className="text-3xl font-bold">Page Title</h1>
      <p className="text-muted-foreground">
        Brief description of the page purpose
      </p>
    </div>
  </div>

  {/* Optional: Alert or additional header content */}
</div>
```

**Key Points**:
- Horizontal padding: `px-4 lg:px-6` (responsive)
- Icon size: `h-6 w-6` (consistent across all pages)
- Icon background: Colored box with rounded corners and dark mode support
- Title: `text-3xl font-bold`
- Description: Uses `text-muted-foreground` for secondary text
- No bottom margin on header - spacing controlled by outer container's `gap`

**Color Palette for Icon Backgrounds**:
- Blue: `bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300`
- Orange: `bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300`
- Green: `bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300`
- Purple: `bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300`
- Red: `bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300`

### Content Sections

Each card/section should be wrapped in its own container:

```tsx
<div className="px-4 lg:px-6 max-w-7xl">
  <Card>
    <CardHeader>
      <CardTitle>Section Title</CardTitle>
      <CardDescription>Section description</CardDescription>
    </CardHeader>
    <CardContent>
      {/* Section content */}
    </CardContent>
  </Card>
</div>
```

**Key Points**:
- Same horizontal padding as header: `px-4 lg:px-6`
- Max width constraint: `max-w-7xl` (prevents content from being too wide on large screens)
- Each major section gets its own wrapper div

### Loading State

```tsx
if (isLoading) {
  return (
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
  );
}
```

**Key Points**:
- Match the structure of the actual page layout
- Icon placeholder: `h-12 w-12` (includes padding)
- Title placeholder: `h-8 w-64`
- Description placeholder: `h-4 w-96`
- Content placeholder: Appropriate height for the content

## Complete Example

### Registry Credentials Page Pattern

```tsx
export default function ExamplePage() {
  const { data, isLoading } = useExampleData();

  if (isLoading) {
    return (
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
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      {/* Header */}
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
            <IconDatabase className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Example Page</h1>
            <p className="text-muted-foreground">
              Description of what this page does
            </p>
          </div>
        </div>
      </div>

      {/* First Section */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>First Section</CardTitle>
            <CardDescription>Section description</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Content here */}
          </CardContent>
        </Card>
      </div>

      {/* Second Section */}
      <div className="px-4 lg:px-6 max-w-7xl">
        <Card>
          <CardHeader>
            <CardTitle>Second Section</CardTitle>
            <CardDescription>Section description</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Content here */}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

## Header with Action Button Pattern

For pages that need a primary action button in the header (like "Add Credential"):

```tsx
<div className="px-4 lg:px-6">
  <div className="flex items-center justify-between">
    <div className="flex items-center gap-3">
      <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
        <Key className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-3xl font-bold">Registry Credentials</h1>
        <p className="text-muted-foreground">
          Manage Docker registry authentication for deployments and operations
        </p>
      </div>
    </div>

    <Button onClick={() => handleOpenDialog("create")}>
      <Plus className="h-4 w-4 mr-2" />
      Add Credential
    </Button>
  </div>
</div>
```

**Key Points**:
- Use `justify-between` to space the header and action button
- Action button aligns to the right
- Maintains the same icon and title structure on the left

## Error State Pattern

```tsx
if (error) {
  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
            <Key className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Page Title</h1>
            <p className="text-muted-foreground">
              Page description
            </p>
          </div>
        </div>

        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load data. Please try refreshing the page.
          </AlertDescription>
        </Alert>
      </div>
    </div>
  );
}
```

## Spacing Guidelines

- **Outer container**: `gap-4 py-4 md:gap-6 md:py-6`
- **Horizontal padding**: `px-4 lg:px-6`
- **Max width**: `max-w-7xl` for content sections (optional - omit for full-width layouts like data tables)
- **Icon-to-title gap**: `gap-3`
- **Form field spacing**: `space-y-4` or `space-y-6`

**Note**: The gap between the header and content sections is controlled by the outer container's `gap-4 md:gap-6` spacing, not by individual margins on the header.

## Typography

- **Page Title**: `text-3xl font-bold`
- **Page Description**: `text-muted-foreground`
- **Card Title**: Use `<CardTitle>` component
- **Card Description**: Use `<CardDescription>` component
- **Section Labels**: `text-sm font-medium`

## Icons

- **Header Icons**: `h-6 w-6` inside `p-3 rounded-md` colored box
- **Button Icons**: `h-4 w-4` with `mr-2` spacing
- **Status Icons**: `h-4 w-4` inline with text

## Responsive Behavior

- Mobile: `gap-4 py-4 px-4`
- Desktop: `gap-6 py-6 lg:px-6`
- Content width: Optionally constrained by `max-w-7xl` (omit for full-width layouts)

## Examples of Pages Using This Pattern

1. **Registry Credentials** (`client/src/app/settings/registry-credentials/page.tsx`)
   - Icon: Orange background with Key icon
   - Action button in header
   - Table with actions
   - Uses `max-w-7xl` for width constraint

2. **Self-Backup Settings** (`client/src/app/settings/self-backup/page.tsx`)
   - Icon: Blue background with Database icon
   - Form configuration card
   - History table card
   - Uses `max-w-7xl` for width constraint

3. **Container Dashboard** (`client/src/app/containers/ContainerDashboard.tsx`)
   - Icon: Blue background with Container icon
   - Full-width layout (no `max-w-7xl`) for data table
   - Multiple states (loading, error, connectivity checks)

## Migration Checklist

When updating an existing page to this pattern:

- [ ] Replace outer container with `flex flex-col gap-4 py-4 md:gap-6 md:py-6`
- [ ] Wrap header in `px-4 lg:px-6` with icon box pattern
- [ ] Update icon to `h-6 w-6` inside colored background box
- [ ] Remove any `mb-6` or other margins from header - spacing controlled by outer container gap
- [ ] Wrap each content section in `px-4 lg:px-6` (add `max-w-7xl` unless full-width needed)
- [ ] Update loading state to match layout structure
- [ ] Ensure error states follow the same layout
- [ ] Verify responsive behavior on mobile and desktop
- [ ] Test dark mode appearance

## Anti-Patterns to Avoid

❌ **Don't** use `container` class on the outer div
✅ **Do** use `flex flex-col` with responsive gaps

❌ **Don't** use different icon sizes for different pages
✅ **Do** use consistent `h-6 w-6` icons in header

❌ **Don't** add `mb-6` or other margins to the header section
✅ **Do** let the outer container's `gap` property control spacing

❌ **Don't** mix `space-y` with `gap` on the same element
✅ **Do** use `gap` for flex containers, `space-y` for stacked content

❌ **Don't** forget dark mode variants for colored backgrounds
✅ **Do** include `dark:` variants for all background colors

❌ **Don't** always use `max-w-7xl` - some layouts need full width
✅ **Do** consider the content type (data tables = full width, forms = constrained)
