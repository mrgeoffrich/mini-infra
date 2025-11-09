# PostgreSQL Server Management - Frontend Implementation Plan

## Executive Summary

This document provides a detailed frontend implementation plan for Phase 1 of the PostgreSQL Server Management feature. The design follows the established page layout patterns, iconography standards, and UI/UX best practices from the Mini Infra application.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Page Designs](#page-designs)
3. [Component Specifications](#component-specifications)
4. [User Flows](#user-flows)
5. [State Management](#state-management)
6. [Accessibility & Responsiveness](#accessibility--responsiveness)
7. [Implementation Checklist](#implementation-checklist)

---

## Design Principles

### Visual Consistency
- Follow the **Registry Credentials** and **Self-Backup** page patterns
- Use standard layout: `flex flex-col gap-4 py-4 md:gap-6 md:py-6`
- Header with icon box pattern
- Purple color scheme for PostgreSQL branding (`bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300`)

### Iconography
- **Primary Icon**: `IconBrandPostgresql` (PostgreSQL elephant logo)
- **Fallback Icon**: `IconDatabase` (when brand icon isn't appropriate)
- **Action Icons**:
  - `IconPlus` for create actions
  - `IconTrash` for delete
  - `IconEdit` or `IconPencil` for edit
  - `IconRefresh` for sync operations
  - `IconSettingsQuestion` for connection testing
  - `IconDatabaseSearch` for database-specific testing
- **Status Icons**:
  - `IconCircleCheck` for healthy/connected
  - `IconCircleX` for failed/disconnected
  - `IconAlertCircle` for warnings
  - `IconClock` for pending operations

### User Experience
- **Progressive Disclosure**: Show simple options first, advanced options in collapsible sections
- **Immediate Feedback**: Loading states, success/error messages, optimistic UI updates
- **Guided Workflows**: Quick Setup wizard for common tasks
- **Safety**: Confirmation dialogs for destructive actions
- **Efficiency**: Keyboard shortcuts, bulk actions where appropriate

---

## Page Designs

### 1. PostgreSQL Server List (`/postgres-server`)

#### Layout Structure

```tsx
<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
  {/* Header with Action Button */}
  <div className="px-4 lg:px-6">
    <div className="flex items-center justify-between">
      {/* Left: Icon + Title */}
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
          <IconBrandPostgresql className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-3xl font-bold">PostgreSQL Servers</h1>
          <p className="text-muted-foreground">
            Manage PostgreSQL server connections, databases, and users
          </p>
        </div>
      </div>

      {/* Right: Add Server Button */}
      <Button onClick={() => handleOpenDialog("create")}>
        <IconPlus className="h-4 w-4 mr-2" />
        Add Server
      </Button>
    </div>
  </div>

  {/* Server List Section */}
  <div className="px-4 lg:px-6 max-w-7xl">
    <Card>
      <CardHeader>
        <CardTitle>Connected Servers</CardTitle>
        <CardDescription>
          PostgreSQL servers you have access to manage
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Server Cards or Table */}
      </CardContent>
    </Card>
  </div>
</div>
```

#### Server Display Options

**Option A: Card Grid (Recommended for < 10 servers)**
- Visual, scannable layout
- Shows key metrics prominently
- Better for visual hierarchy
- Responsive grid: 1 column mobile, 2-3 columns desktop

```tsx
<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
  {servers.map((server) => (
    <Card key={server.id} className="hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <IconBrandPostgresql className="h-5 w-5 text-purple-600" />
            <CardTitle className="text-lg">{server.name}</CardTitle>
          </div>
          <HealthStatusBadge status={server.healthStatus} />
        </div>
        <CardDescription className="flex items-center gap-1 text-xs">
          <IconServer className="h-3 w-3" />
          {server.host}:{server.port}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Metrics */}
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="space-y-1">
            <div className="text-2xl font-bold text-purple-600">
              {server._count.databases}
            </div>
            <div className="text-muted-foreground text-xs">Databases</div>
          </div>
          <div className="space-y-1">
            <div className="text-2xl font-bold text-blue-600">
              {server._count.users}
            </div>
            <div className="text-muted-foreground text-xs">Users</div>
          </div>
          <div className="space-y-1">
            <div className="text-2xl font-bold text-green-600">
              {calculateTotalGrants(server)}
            </div>
            <div className="text-muted-foreground text-xs">Grants</div>
          </div>
        </div>

        {/* Server Version */}
        {server.serverVersion && (
          <div className="text-xs text-muted-foreground border-t pt-2">
            {server.serverVersion}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => navigate(`/postgres-server/${server.id}`)}
          >
            <IconEye className="h-4 w-4 mr-1" />
            Manage
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleEdit(server)}
          >
            <IconEdit className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDelete(server)}
          >
            <IconTrash className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  ))}
</div>
```

**Option B: Data Table (Recommended for 10+ servers)**
- Sortable, filterable columns
- Compact, information-dense
- Better for many servers
- Uses `@tanstack/react-table`

```tsx
<DataTable
  columns={[
    { accessorKey: "name", header: "Server Name" },
    { accessorKey: "host", header: "Host" },
    { accessorKey: "serverVersion", header: "Version" },
    { accessorKey: "healthStatus", header: "Status", cell: HealthStatusCell },
    { accessorKey: "_count.databases", header: "Databases" },
    { accessorKey: "_count.users", header: "Users" },
    { id: "actions", header: "Actions", cell: ActionsCell }
  ]}
  data={servers}
/>
```

#### Empty State

```tsx
<div className="flex flex-col items-center justify-center py-12 text-center">
  <div className="p-4 rounded-full bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300 mb-4">
    <IconBrandPostgresql className="h-12 w-12" />
  </div>
  <h3 className="text-lg font-semibold mb-2">No PostgreSQL Servers</h3>
  <p className="text-muted-foreground mb-4 max-w-sm">
    Connect to your first PostgreSQL server to start managing databases and users
  </p>
  <Button onClick={() => handleOpenDialog("create")}>
    <IconPlus className="h-4 w-4 mr-2" />
    Add Your First Server
  </Button>
</div>
```

#### Loading State

```tsx
<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
  {[1, 2, 3].map((i) => (
    <Card key={i}>
      <CardHeader>
        <Skeleton className="h-6 w-32 mb-2" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  ))}
</div>
```

---

### 2. Server Details Page (`/postgres-server/:serverId`)

#### Layout Structure

```tsx
<div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
  {/* Breadcrumb Navigation */}
  <div className="px-4 lg:px-6">
    <Breadcrumb>
      <BreadcrumbItem>
        <IconBrandPostgresql className="h-4 w-4" />
        PostgreSQL Servers
      </BreadcrumbItem>
      <BreadcrumbSeparator />
      <BreadcrumbItem>{server.name}</BreadcrumbItem>
    </Breadcrumb>
  </div>

  {/* Header */}
  <div className="px-4 lg:px-6">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-md bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">
          <IconBrandPostgresql className="h-6 w-6" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold">{server.name}</h1>
            <HealthStatusBadge status={server.healthStatus} />
          </div>
          <p className="text-muted-foreground">
            {server.host}:{server.port}
          </p>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <Button variant="outline" onClick={handleSync}>
          <IconRefresh className="h-4 w-4 mr-2" />
          Sync from Server
        </Button>
        <Button variant="outline" onClick={handleEdit}>
          <IconEdit className="h-4 w-4 mr-2" />
          Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon">
              <IconDots className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleTestConnection}>
              <IconSettingsQuestion className="h-4 w-4 mr-2" />
              Test Connection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleDelete}
              className="text-destructive"
            >
              <IconTrash className="h-4 w-4 mr-2" />
              Delete Server
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </div>

  {/* Tabs */}
  <div className="px-4 lg:px-6">
    <Tabs defaultValue="overview" className="space-y-4">
      <TabsList className="grid w-full grid-cols-4 lg:w-auto lg:inline-grid">
        <TabsTrigger value="overview">
          <IconDashboard className="h-4 w-4 mr-2" />
          Overview
        </TabsTrigger>
        <TabsTrigger value="databases">
          <IconDatabase className="h-4 w-4 mr-2" />
          Databases
        </TabsTrigger>
        <TabsTrigger value="users">
          <IconUser className="h-4 w-4 mr-2" />
          Users
        </TabsTrigger>
        <TabsTrigger value="quick-setup">
          <IconBolt className="h-4 w-4 mr-2" />
          Quick Setup
        </TabsTrigger>
      </TabsList>

      {/* Tab Content */}
      <TabsContent value="overview">
        {/* Overview Tab Content */}
      </TabsContent>

      <TabsContent value="databases">
        {/* Databases Tab Content */}
      </TabsContent>

      <TabsContent value="users">
        {/* Users Tab Content */}
      </TabsContent>

      <TabsContent value="quick-setup">
        {/* Quick Setup Tab Content */}
      </TabsContent>
    </Tabs>
  </div>
</div>
```

#### Tab 1: Overview

```tsx
<div className="space-y-4">
  {/* Server Info Card */}
  <Card>
    <CardHeader>
      <CardTitle>Server Information</CardTitle>
      <CardDescription>Connection details and status</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Connection Info */}
        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">Host</Label>
          <div className="font-mono text-sm">{server.host}:{server.port}</div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">Admin Username</Label>
          <div className="font-mono text-sm">{server.adminUsername}</div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">SSL Mode</Label>
          <div className="font-mono text-sm">{server.sslMode}</div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">Server Version</Label>
          <div className="font-mono text-sm">
            {server.serverVersion || "Unknown"}
          </div>
        </div>
      </div>

      {/* Health Status */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-sm text-muted-foreground">Health Status</Label>
            <div className="flex items-center gap-2">
              <HealthStatusBadge status={server.healthStatus} />
              {server.lastHealthCheck && (
                <span className="text-xs text-muted-foreground">
                  Last checked {formatRelativeTime(server.lastHealthCheck)}
                </span>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleTestConnection}
          >
            <IconRefresh className="h-4 w-4 mr-2" />
            Check Now
          </Button>
        </div>
      </div>

      {/* Tags */}
      {server.tags && server.tags.length > 0 && (
        <div className="border-t pt-4">
          <Label className="text-sm text-muted-foreground mb-2 block">Tags</Label>
          <div className="flex flex-wrap gap-2">
            {server.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </CardContent>
  </Card>

  {/* Statistics Card */}
  <Card>
    <CardHeader>
      <CardTitle>Resource Summary</CardTitle>
      <CardDescription>Databases, users, and grants on this server</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Databases */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <IconDatabase className="h-4 w-4" />
            <span className="text-sm">Databases</span>
          </div>
          <div className="text-3xl font-bold text-purple-600">
            {server._count.databases}
          </div>
          <Button
            variant="link"
            className="p-0 h-auto"
            onClick={() => setActiveTab("databases")}
          >
            View all databases →
          </Button>
        </div>

        {/* Users */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <IconUser className="h-4 w-4" />
            <span className="text-sm">Users</span>
          </div>
          <div className="text-3xl font-bold text-blue-600">
            {server._count.users}
          </div>
          <Button
            variant="link"
            className="p-0 h-auto"
            onClick={() => setActiveTab("users")}
          >
            View all users →
          </Button>
        </div>

        {/* Total Grants */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <IconShield className="h-4 w-4" />
            <span className="text-sm">Active Grants</span>
          </div>
          <div className="text-3xl font-bold text-green-600">
            {calculateTotalGrants(server)}
          </div>
          <div className="text-sm text-muted-foreground">
            Permission assignments
          </div>
        </div>
      </div>
    </CardContent>
  </Card>

  {/* Recent Activity Card */}
  <Card>
    <CardHeader>
      <CardTitle>Recent Activity</CardTitle>
      <CardDescription>Latest changes and operations</CardDescription>
    </CardHeader>
    <CardContent>
      {/* Activity feed or "No recent activity" message */}
      <div className="text-center text-muted-foreground py-6">
        <IconHistory className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No recent activity</p>
      </div>
    </CardContent>
  </Card>
</div>
```

#### Tab 2: Databases

```tsx
<div className="space-y-4">
  {/* Header with Create Button */}
  <Card>
    <CardHeader>
      <div className="flex items-center justify-between">
        <div>
          <CardTitle>Databases</CardTitle>
          <CardDescription>
            Manage databases on {server.name}
          </CardDescription>
        </div>
        <Button onClick={() => handleCreateDatabase()}>
          <IconPlus className="h-4 w-4 mr-2" />
          Create Database
        </Button>
      </div>
    </CardHeader>
    <CardContent>
      {databases.length === 0 ? (
        <EmptyState
          icon={IconDatabase}
          title="No databases found"
          description="Create your first database or sync from the server to see existing databases"
          action={
            <div className="flex gap-2">
              <Button onClick={handleSyncDatabases}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Sync from Server
              </Button>
              <Button onClick={handleCreateDatabase}>
                <IconPlus className="h-4 w-4 mr-2" />
                Create Database
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {/* Sync indicator */}
          <div className="flex items-center justify-between mb-4 pb-4 border-b">
            <div className="text-sm text-muted-foreground">
              {databases.length} database{databases.length !== 1 ? 's' : ''}
              {lastSyncedAt && (
                <span className="ml-2">
                  • Last synced {formatRelativeTime(lastSyncedAt)}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncDatabases}
              disabled={isSyncing}
            >
              <IconRefresh className={cn(
                "h-4 w-4 mr-2",
                isSyncing && "animate-spin"
              )} />
              Sync
            </Button>
          </div>

          {/* Database Table */}
          <div className="space-y-2">
            {databases.map((db) => (
              <div
                key={db.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start gap-3 flex-1">
                  <IconDatabase className="h-5 w-5 text-purple-600 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-sm">{db.databaseName}</h4>
                      {db._count.grants > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          {db._count.grants} grant{db._count.grants !== 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2 text-xs text-muted-foreground">
                      <div>
                        <span className="font-medium">Owner:</span> {db.owner}
                      </div>
                      <div>
                        <span className="font-medium">Encoding:</span> {db.encoding}
                      </div>
                      {db.sizeBytes && (
                        <div>
                          <span className="font-medium">Size:</span> {formatBytes(db.sizeBytes)}
                        </div>
                      )}
                      {db.connectionLimit !== -1 && (
                        <div>
                          <span className="font-medium">Connections:</span> {db.connectionLimit}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleViewGrants(db)}
                  >
                    <IconShield className="h-4 w-4 mr-1" />
                    Grants
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <IconDots className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleViewDetails(db)}>
                        <IconEye className="h-4 w-4 mr-2" />
                        View Details
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => handleDropDatabase(db)}
                        className="text-destructive"
                      >
                        <IconTrash className="h-4 w-4 mr-2" />
                        Drop Database
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </CardContent>
  </Card>
</div>
```

#### Tab 3: Users

```tsx
<div className="space-y-4">
  {/* Header with Create Button and Filter */}
  <Card>
    <CardHeader>
      <div className="flex items-center justify-between">
        <div>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            Manage database users on {server.name}
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setShowSystemUsers(!showSystemUsers)}
          >
            <IconFilter className="h-4 w-4 mr-2" />
            {showSystemUsers ? "Hide System Users" : "Show System Users"}
          </Button>
          <Button onClick={() => handleCreateUser()}>
            <IconPlus className="h-4 w-4 mr-2" />
            Create User
          </Button>
        </div>
      </div>
    </CardHeader>
    <CardContent>
      {filteredUsers.length === 0 ? (
        <EmptyState
          icon={IconUser}
          title={showSystemUsers ? "No users found" : "No application users"}
          description={
            showSystemUsers
              ? "Create your first user or sync from the server"
              : "Create application users or show system users to see all"
          }
          action={
            <div className="flex gap-2">
              <Button onClick={handleSyncUsers}>
                <IconRefresh className="h-4 w-4 mr-2" />
                Sync from Server
              </Button>
              <Button onClick={handleCreateUser}>
                <IconPlus className="h-4 w-4 mr-2" />
                Create User
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {/* Sync indicator */}
          <div className="flex items-center justify-between mb-4 pb-4 border-b">
            <div className="text-sm text-muted-foreground">
              {filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}
              {!showSystemUsers && users.length > filteredUsers.length && (
                <span className="ml-2">
                  ({users.length - filteredUsers.length} system users hidden)
                </span>
              )}
              {lastSyncedAt && (
                <span className="ml-2">
                  • Last synced {formatRelativeTime(lastSyncedAt)}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncUsers}
              disabled={isSyncing}
            >
              <IconRefresh className={cn(
                "h-4 w-4 mr-2",
                isSyncing && "animate-spin"
              )} />
              Sync
            </Button>
          </div>

          {/* User List */}
          <div className="space-y-2">
            {filteredUsers.map((user) => (
              <div
                key={user.id}
                className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start gap-3 flex-1">
                  <IconUser className="h-5 w-5 text-blue-600 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-sm font-mono">{user.username}</h4>

                      {user.isSuperuser && (
                        <Badge variant="destructive" className="text-xs">
                          Superuser
                        </Badge>
                      )}

                      {!user.canLogin && (
                        <Badge variant="secondary" className="text-xs">
                          No Login
                        </Badge>
                      )}

                      {user._count.grants > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {user._count.grants} grant{user._count.grants !== 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>

                    <div className="flex gap-4 mt-2 text-xs text-muted-foreground">
                      {user.connectionLimit !== -1 && (
                        <div>
                          <span className="font-medium">Connection Limit:</span> {user.connectionLimit}
                        </div>
                      )}
                      {user.passwordSetAt && (
                        <div>
                          <span className="font-medium">Password Set:</span>{" "}
                          {formatRelativeTime(user.passwordSetAt)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleViewGrants(user)}
                  >
                    <IconShield className="h-4 w-4 mr-1" />
                    Grants
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        <IconDots className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleEditUser(user)}>
                        <IconEdit className="h-4 w-4 mr-2" />
                        Edit User
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleChangePassword(user)}>
                        <IconKey className="h-4 w-4 mr-2" />
                        Change Password
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => handleDropUser(user)}
                        className="text-destructive"
                        disabled={user.isSuperuser}
                      >
                        <IconTrash className="h-4 w-4 mr-2" />
                        Drop User
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </CardContent>
  </Card>
</div>
```

#### Tab 4: Quick Setup

```tsx
<div className="max-w-3xl mx-auto">
  <Card>
    <CardHeader>
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
          <IconBolt className="h-6 w-6" />
        </div>
        <div>
          <CardTitle>Quick Application Database Setup</CardTitle>
          <CardDescription>
            Create a database, user, and grant full permissions in one step
          </CardDescription>
        </div>
      </div>
    </CardHeader>
    <CardContent>
      <Alert className="mb-6">
        <IconInfoCircle className="h-4 w-4" />
        <AlertDescription>
          This workflow creates a new database with a dedicated user that has full permissions.
          Perfect for setting up a new application database quickly.
        </AlertDescription>
      </Alert>

      {/* Quick Setup Wizard Component */}
      <QuickSetupWizard serverId={server.id} />
    </CardContent>
  </Card>

  {/* Recent Quick Setups (Optional) */}
  {recentSetups.length > 0 && (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-lg">Recent Quick Setups</CardTitle>
        <CardDescription>Previously created via quick setup</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {recentSetups.map((setup) => (
            <div
              key={setup.id}
              className="flex items-center justify-between p-3 border rounded-lg"
            >
              <div className="flex items-center gap-3">
                <IconCircleCheck className="h-5 w-5 text-green-600" />
                <div>
                  <div className="font-medium text-sm">
                    {setup.databaseName}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    User: {setup.username} • {formatRelativeTime(setup.createdAt)}
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleShowConnectionString(setup)}
              >
                <IconCopy className="h-4 w-4 mr-1" />
                Connection String
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )}
</div>
```

---

## Component Specifications

### 1. ServerModal (`client/src/components/postgres-server/server-modal.tsx`)

**Purpose**: Create or edit PostgreSQL server connection

**Props**:
```tsx
interface ServerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  serverId?: string; // Required for edit mode
}
```

**Layout**:
```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-w-2xl">
    <DialogHeader>
      <DialogTitle>
        {mode === "create" ? "Add PostgreSQL Server" : "Edit PostgreSQL Server"}
      </DialogTitle>
      <DialogDescription>
        {mode === "create"
          ? "Connect to a PostgreSQL server with admin credentials"
          : "Update server connection details"
        }
      </DialogDescription>
    </DialogHeader>

    <form onSubmit={handleSubmit}>
      <div className="space-y-4 py-4">
        {/* Server Name */}
        <div className="space-y-2">
          <Label htmlFor="name">Server Name *</Label>
          <Input
            id="name"
            placeholder="Production Database Server"
            {...register("name")}
          />
          {errors.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>

        {/* Connection Details */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="host">Host *</Label>
            <Input
              id="host"
              placeholder="localhost"
              {...register("host")}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="port">Port *</Label>
            <Input
              id="port"
              type="number"
              placeholder="5432"
              {...register("port", { valueAsNumber: true })}
            />
          </div>
        </div>

        {/* Admin Credentials */}
        <div className="space-y-2">
          <Label htmlFor="adminUsername">Admin Username *</Label>
          <Input
            id="adminUsername"
            placeholder="postgres"
            autoComplete="username"
            {...register("adminUsername")}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="adminPassword">Admin Password *</Label>
          <div className="relative">
            <Input
              id="adminPassword"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              autoComplete="current-password"
              {...register("adminPassword")}
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
        </div>

        {/* SSL Mode */}
        <div className="space-y-2">
          <Label htmlFor="sslMode">SSL Mode</Label>
          <Select
            value={sslMode}
            onValueChange={(value) => setValue("sslMode", value)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="prefer">Prefer (recommended)</SelectItem>
              <SelectItem value="require">Require</SelectItem>
              <SelectItem value="disable">Disable</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            "Prefer" attempts SSL first, falls back to non-SSL if unavailable
          </p>
        </div>

        {/* Advanced Options (Collapsible) */}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between">
              <span>Advanced Options</span>
              <IconChevronDown className="h-4 w-4" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            {/* Tags */}
            <div className="space-y-2">
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                placeholder="production, us-east, postgres-15"
                {...register("tags")}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated tags for organization
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Test Connection Result */}
        {testResult && (
          <Alert variant={testResult.success ? "default" : "destructive"}>
            {testResult.success ? (
              <IconCircleCheck className="h-4 w-4" />
            ) : (
              <IconAlertCircle className="h-4 w-4" />
            )}
            <AlertDescription>
              {testResult.message}
              {testResult.version && (
                <div className="mt-1 text-xs">Version: {testResult.version}</div>
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={handleTestConnection}
          disabled={isTestingConnection}
        >
          {isTestingConnection ? (
            <>
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              Testing...
            </>
          ) : (
            <>
              <IconSettingsQuestion className="h-4 w-4 mr-2" />
              Test Connection
            </>
          )}
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              {mode === "create" ? "Adding..." : "Saving..."}
            </>
          ) : (
            <>
              {mode === "create" ? "Add Server" : "Save Changes"}
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

**Validation Schema**:
```tsx
const serverSchema = z.object({
  name: z.string().min(1, "Server name is required"),
  host: z.string().min(1, "Host is required"),
  port: z.number().min(1).max(65535),
  adminUsername: z.string().min(1, "Admin username is required"),
  adminPassword: z.string().min(1, "Admin password is required"),
  sslMode: z.enum(["prefer", "require", "disable"]),
  tags: z.string().optional()
});
```

**Features**:
- Form validation with react-hook-form + Zod
- Password visibility toggle
- Test connection button (validates before saving)
- Collapsible advanced options
- Real-time validation feedback
- Loading states for async operations

---

### 2. DatabaseModal (`client/src/components/postgres-server/database-modal.tsx`)

**Purpose**: Create new database on a server

**Props**:
```tsx
interface DatabaseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  availableUsers: ManagedDatabaseUser[]; // For owner dropdown
}
```

**Layout**:
```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-w-xl">
    <DialogHeader>
      <DialogTitle>Create Database</DialogTitle>
      <DialogDescription>
        Create a new database on this PostgreSQL server
      </DialogDescription>
    </DialogHeader>

    <form onSubmit={handleSubmit}>
      <div className="space-y-4 py-4">
        {/* Database Name */}
        <div className="space-y-2">
          <Label htmlFor="databaseName">Database Name *</Label>
          <Input
            id="databaseName"
            placeholder="my_application_db"
            {...register("databaseName")}
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, numbers, and underscores only
          </p>
        </div>

        {/* Owner */}
        <div className="space-y-2">
          <Label htmlFor="owner">Owner</Label>
          <Select
            value={owner}
            onValueChange={(value) => setValue("owner", value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select owner user..." />
            </SelectTrigger>
            <SelectContent>
              {availableUsers.map((user) => (
                <SelectItem key={user.id} value={user.username}>
                  {user.username}
                  {user.isSuperuser && " (superuser)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Optional: Assign a user as the database owner
          </p>
        </div>

        {/* Advanced Options (Collapsible) */}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between">
              <span>Advanced Options</span>
              <IconChevronDown className="h-4 w-4" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            {/* Encoding */}
            <div className="space-y-2">
              <Label htmlFor="encoding">Encoding</Label>
              <Select
                value={encoding}
                onValueChange={(value) => setValue("encoding", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="UTF8">UTF8 (recommended)</SelectItem>
                  <SelectItem value="SQL_ASCII">SQL_ASCII</SelectItem>
                  <SelectItem value="LATIN1">LATIN1</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Template */}
            <div className="space-y-2">
              <Label htmlFor="template">Template</Label>
              <Select
                value={template}
                onValueChange={(value) => setValue("template", value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="template0">template0 (clean)</SelectItem>
                  <SelectItem value="template1">template1 (default)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                template0 is recommended for custom encoding
              </p>
            </div>

            {/* Connection Limit */}
            <div className="space-y-2">
              <Label htmlFor="connectionLimit">Connection Limit</Label>
              <Input
                id="connectionLimit"
                type="number"
                placeholder="-1 (unlimited)"
                {...register("connectionLimit", { valueAsNumber: true })}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
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
              Create Database
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

**Validation Schema**:
```tsx
const databaseSchema = z.object({
  databaseName: z.string()
    .min(1, "Database name is required")
    .regex(/^[a-z0-9_]+$/, "Only lowercase letters, numbers, and underscores"),
  owner: z.string().optional(),
  encoding: z.string().default("UTF8"),
  template: z.string().default("template0"),
  connectionLimit: z.number().default(-1)
});
```

---

### 3. UserModal (`client/src/components/postgres-server/user-modal.tsx`)

**Purpose**: Create or edit database user

**Props**:
```tsx
interface UserModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "create" | "edit";
  userId?: string; // Required for edit mode
}
```

**Layout**:
```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-w-xl">
    <DialogHeader>
      <DialogTitle>
        {mode === "create" ? "Create User" : "Edit User"}
      </DialogTitle>
      <DialogDescription>
        {mode === "create"
          ? "Create a new database user"
          : "Update user attributes"
        }
      </DialogDescription>
    </DialogHeader>

    <form onSubmit={handleSubmit}>
      <div className="space-y-4 py-4">
        {/* Username */}
        <div className="space-y-2">
          <Label htmlFor="username">Username *</Label>
          <Input
            id="username"
            placeholder="app_user"
            disabled={mode === "edit"}
            {...register("username")}
          />
          <p className="text-xs text-muted-foreground">
            {mode === "edit"
              ? "Username cannot be changed"
              : "Lowercase letters, numbers, and underscores only"
            }
          </p>
        </div>

        {/* Password (Create mode only) */}
        {mode === "create" && (
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
            <p className="text-xs text-muted-foreground">
              Strong password recommended (12+ characters)
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
              onCheckedChange={(checked) => setValue("isSuperuser", checked)}
            />
          </div>

          {isSuperuser && (
            <Alert variant="destructive">
              <IconAlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Superuser has unrestricted access to all databases and can modify system settings.
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Advanced Options */}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between">
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

        {/* Edit mode: Change Password Note */}
        {mode === "edit" && (
          <Alert>
            <IconInfoCircle className="h-4 w-4" />
            <AlertDescription>
              To change the password, use the "Change Password" action from the user menu.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              {mode === "create" ? "Creating..." : "Saving..."}
            </>
          ) : (
            <>
              {mode === "create" ? "Create User" : "Save Changes"}
            </>
          )}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

**Validation Schema**:
```tsx
const userSchema = z.object({
  username: z.string()
    .min(1, "Username is required")
    .regex(/^[a-z0-9_]+$/, "Only lowercase letters, numbers, and underscores"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  canLogin: z.boolean().default(true),
  isSuperuser: z.boolean().default(false),
  connectionLimit: z.number().default(-1)
});
```

---

### 4. GrantEditor (`client/src/components/postgres-server/grant-editor.tsx`)

**Purpose**: Manage database permissions for a user

**Props**:
```tsx
interface GrantEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  databaseId: string;
  userId: string;
  existingGrant?: DatabaseGrant; // For editing existing grant
}
```

**Layout**:
```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent className="max-w-2xl">
    <DialogHeader>
      <DialogTitle>Manage Database Permissions</DialogTitle>
      <DialogDescription>
        Configure access permissions for {user.username} on {database.databaseName}
      </DialogDescription>
    </DialogHeader>

    <div className="space-y-6 py-4">
      {/* Quick Presets */}
      <div className="space-y-2">
        <Label>Permission Presets</Label>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Button
            type="button"
            variant={preset === "none" ? "default" : "outline"}
            onClick={() => applyPreset("none")}
            className="justify-start"
          >
            <IconBan className="h-4 w-4 mr-2" />
            No Access
          </Button>
          <Button
            type="button"
            variant={preset === "readonly" ? "default" : "outline"}
            onClick={() => applyPreset("readonly")}
            className="justify-start"
          >
            <IconEye className="h-4 w-4 mr-2" />
            Read Only
          </Button>
          <Button
            type="button"
            variant={preset === "readwrite" ? "default" : "outline"}
            onClick={() => applyPreset("readwrite")}
            className="justify-start"
          >
            <IconEdit className="h-4 w-4 mr-2" />
            Read/Write
          </Button>
          <Button
            type="button"
            variant={preset === "full" ? "default" : "outline"}
            onClick={() => applyPreset("full")}
            className="justify-start"
          >
            <IconShield className="h-4 w-4 mr-2" />
            Full Access
          </Button>
        </div>
      </div>

      <Separator />

      {/* Database-Level Privileges */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <IconDatabase className="h-5 w-5 text-purple-600" />
          <h4 className="font-semibold">Database Privileges</h4>
        </div>

        <div className="space-y-2 pl-7">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="canConnect" className="font-normal">
                CONNECT
              </Label>
              <p className="text-xs text-muted-foreground">
                Allow connection to this database
              </p>
            </div>
            <Switch
              id="canConnect"
              checked={permissions.canConnect}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canConnect: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="canCreate" className="font-normal">
                CREATE
              </Label>
              <p className="text-xs text-muted-foreground">
                Create new schemas in the database
              </p>
            </div>
            <Switch
              id="canCreate"
              checked={permissions.canCreate}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canCreate: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="canTemp" className="font-normal">
                TEMP
              </Label>
              <p className="text-xs text-muted-foreground">
                Create temporary tables
              </p>
            </div>
            <Switch
              id="canTemp"
              checked={permissions.canTemp}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canTemp: checked }))
              }
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Schema-Level Privileges */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <IconFolders className="h-5 w-5 text-blue-600" />
          <h4 className="font-semibold">Schema Privileges (public schema)</h4>
        </div>

        <div className="space-y-2 pl-7">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="canUsageSchema" className="font-normal">
                USAGE
              </Label>
              <p className="text-xs text-muted-foreground">
                Access objects in the schema
              </p>
            </div>
            <Switch
              id="canUsageSchema"
              checked={permissions.canUsageSchema}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canUsageSchema: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="canCreateSchema" className="font-normal">
                CREATE
              </Label>
              <p className="text-xs text-muted-foreground">
                Create objects in the schema
              </p>
            </div>
            <Switch
              id="canCreateSchema"
              checked={permissions.canCreateSchema}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canCreateSchema: checked }))
              }
            />
          </div>
        </div>
      </div>

      <Separator />

      {/* Table-Level Privileges */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <IconTable className="h-5 w-5 text-green-600" />
          <h4 className="font-semibold">Table Privileges (all tables)</h4>
        </div>

        <div className="grid grid-cols-2 gap-3 pl-7">
          <div className="flex items-center justify-between">
            <Label htmlFor="canSelect" className="font-normal">
              SELECT
            </Label>
            <Switch
              id="canSelect"
              checked={permissions.canSelect}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canSelect: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="canInsert" className="font-normal">
              INSERT
            </Label>
            <Switch
              id="canInsert"
              checked={permissions.canInsert}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canInsert: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="canUpdate" className="font-normal">
              UPDATE
            </Label>
            <Switch
              id="canUpdate"
              checked={permissions.canUpdate}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canUpdate: checked }))
              }
            />
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="canDelete" className="font-normal">
              DELETE
            </Label>
            <Switch
              id="canDelete"
              checked={permissions.canDelete}
              onCheckedChange={(checked) =>
                setPermissions(prev => ({ ...prev, canDelete: checked }))
              }
            />
          </div>
        </div>
      </div>

      {/* Warning for No Access */}
      {!permissions.canConnect && (
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            User will not be able to connect to this database. All other permissions require CONNECT privilege.
          </AlertDescription>
        </Alert>
      )}
    </div>

    <DialogFooter>
      {existingGrant && (
        <Button
          type="button"
          variant="destructive"
          onClick={handleRevokeAll}
          disabled={isSubmitting}
        >
          <IconTrash className="h-4 w-4 mr-2" />
          Revoke All
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
      <Button
        onClick={handleSave}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
            Saving...
          </>
        ) : (
          <>
            <IconCheck className="h-4 w-4 mr-2" />
            Save Permissions
          </>
        )}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Preset Configurations**:
```tsx
const PERMISSION_PRESETS = {
  none: {
    canConnect: false,
    canCreate: false,
    canTemp: false,
    canCreateSchema: false,
    canUsageSchema: false,
    canSelect: false,
    canInsert: false,
    canUpdate: false,
    canDelete: false
  },
  readonly: {
    canConnect: true,
    canCreate: false,
    canTemp: false,
    canCreateSchema: false,
    canUsageSchema: true,
    canSelect: true,
    canInsert: false,
    canUpdate: false,
    canDelete: false
  },
  readwrite: {
    canConnect: true,
    canCreate: false,
    canTemp: true,
    canCreateSchema: false,
    canUsageSchema: true,
    canSelect: true,
    canInsert: true,
    canUpdate: true,
    canDelete: true
  },
  full: {
    canConnect: true,
    canCreate: true,
    canTemp: true,
    canCreateSchema: true,
    canUsageSchema: true,
    canSelect: true,
    canInsert: true,
    canUpdate: true,
    canDelete: true
  }
};
```

---

### 5. QuickSetupWizard (`client/src/components/postgres-server/quick-setup-wizard.tsx`)

**Purpose**: Multi-step wizard for creating database + user + grants

**Props**:
```tsx
interface QuickSetupWizardProps {
  serverId: string;
}
```

**Steps**:
1. Database details
2. User credentials
3. Review and confirm
4. Success (show connection string)

**Layout**:
```tsx
<div className="space-y-6">
  {/* Progress Indicator */}
  <div className="flex items-center justify-between">
    {STEPS.map((stepName, index) => (
      <React.Fragment key={stepName}>
        <div className="flex items-center gap-2">
          <div className={cn(
            "flex items-center justify-center w-8 h-8 rounded-full border-2",
            index < currentStep && "bg-primary border-primary text-primary-foreground",
            index === currentStep && "border-primary text-primary",
            index > currentStep && "border-muted text-muted-foreground"
          )}>
            {index < currentStep ? (
              <IconCheck className="h-4 w-4" />
            ) : (
              <span className="text-sm font-medium">{index + 1}</span>
            )}
          </div>
          <span className={cn(
            "text-sm font-medium hidden md:inline",
            index === currentStep && "text-foreground",
            index !== currentStep && "text-muted-foreground"
          )}>
            {stepName}
          </span>
        </div>
        {index < STEPS.length - 1 && (
          <div className="flex-1 h-0.5 mx-2 bg-border" />
        )}
      </React.Fragment>
    ))}
  </div>

  {/* Step Content */}
  <form onSubmit={handleSubmit}>
    {/* Step 1: Database Details */}
    {currentStep === 0 && (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="databaseName">Database Name *</Label>
          <Input
            id="databaseName"
            placeholder="my_app_database"
            {...register("databaseName")}
          />
          {errors.databaseName && (
            <p className="text-sm text-destructive">{errors.databaseName.message}</p>
          )}
        </div>

        <Alert>
          <IconInfoCircle className="h-4 w-4" />
          <AlertDescription>
            This will create a new database with UTF8 encoding and template0.
          </AlertDescription>
        </Alert>
      </div>
    )}

    {/* Step 2: User Credentials */}
    {currentStep === 1 && (
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="username">Username *</Label>
          <Input
            id="username"
            placeholder="app_user"
            {...register("username")}
          />
          {errors.username && (
            <p className="text-sm text-destructive">{errors.username.message}</p>
          )}
        </div>

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
            <p className="text-sm text-destructive">{errors.password.message}</p>
          )}
        </div>

        <Alert>
          <IconInfoCircle className="h-4 w-4" />
          <AlertDescription>
            This user will be created with full permissions on the database (SELECT, INSERT, UPDATE, DELETE).
          </AlertDescription>
        </Alert>
      </div>
    )}

    {/* Step 3: Review */}
    {currentStep === 2 && (
      <div className="space-y-4">
        <Alert>
          <IconInfoCircle className="h-4 w-4" />
          <AlertDescription>
            Review your configuration before creating.
          </AlertDescription>
        </Alert>

        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <IconDatabase className="h-5 w-5 text-purple-600 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold">Database</div>
              <div className="text-sm text-muted-foreground font-mono">
                {formData.databaseName}
              </div>
            </div>
          </div>

          <Separator />

          <div className="flex items-start gap-3">
            <IconUser className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold">User</div>
              <div className="text-sm text-muted-foreground font-mono">
                {formData.username}
              </div>
            </div>
          </div>

          <Separator />

          <div className="flex items-start gap-3">
            <IconShield className="h-5 w-5 text-green-600 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold">Permissions</div>
              <div className="text-sm text-muted-foreground">
                Full access (CONNECT, SELECT, INSERT, UPDATE, DELETE)
              </div>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* Step 4: Success */}
    {currentStep === 3 && result && (
      <div className="space-y-4">
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <div className="p-4 rounded-full bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300 mb-4">
            <IconCircleCheck className="h-12 w-12" />
          </div>
          <h3 className="text-lg font-semibold mb-2">Successfully Created!</h3>
          <p className="text-muted-foreground max-w-md">
            Your database, user, and permissions have been configured.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Connection String</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={result.connectionString}
              className="font-mono text-sm"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(result.connectionString);
                toast.success("Connection string copied!");
              }}
            >
              <IconCopy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use this connection string in your application
          </p>
        </div>

        <Alert>
          <IconInfoCircle className="h-4 w-4" />
          <AlertDescription>
            Save this connection string securely. You can also find the database and user in their respective tabs.
          </AlertDescription>
        </Alert>
      </div>
    )}

    {/* Navigation Buttons */}
    <div className="flex justify-between pt-6 border-t">
      <Button
        type="button"
        variant="outline"
        onClick={handlePrevious}
        disabled={currentStep === 0 || currentStep === 3}
      >
        <IconArrowLeft className="h-4 w-4 mr-2" />
        Previous
      </Button>

      {currentStep < 2 && (
        <Button
          type="button"
          onClick={handleNext}
          disabled={!canProceed()}
        >
          Next
          <IconArrowRight className="h-4 w-4 ml-2" />
        </Button>
      )}

      {currentStep === 2 && (
        <Button
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <IconBolt className="h-4 w-4 mr-2" />
              Create Everything
            </>
          )}
        </Button>
      )}

      {currentStep === 3 && (
        <Button
          type="button"
          onClick={handleReset}
        >
          Create Another
        </Button>
      )}
    </div>
  </form>
</div>
```

**Steps Array**:
```tsx
const STEPS = [
  "Database",
  "User",
  "Review",
  "Complete"
];
```

---

### 6. Health Status Badge (`client/src/components/postgres-server/health-status-badge.tsx`)

**Purpose**: Reusable component for showing server health status

**Props**:
```tsx
interface HealthStatusBadgeProps {
  status: "healthy" | "unhealthy" | "unknown";
  size?: "sm" | "md" | "lg";
}
```

**Implementation**:
```tsx
export function HealthStatusBadge({ status, size = "md" }: HealthStatusBadgeProps) {
  const config = {
    healthy: {
      icon: IconCircleCheck,
      label: "Healthy",
      className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    },
    unhealthy: {
      icon: IconCircleX,
      label: "Unhealthy",
      className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
    },
    unknown: {
      icon: IconAlertCircle,
      label: "Unknown",
      className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300"
    }
  };

  const { icon: Icon, label, className } = config[status];

  const sizeClasses = {
    sm: "text-xs px-2 py-0.5",
    md: "text-sm px-2.5 py-1",
    lg: "text-base px-3 py-1.5"
  };

  const iconSizes = {
    sm: "h-3 w-3",
    md: "h-4 w-4",
    lg: "h-5 w-5"
  };

  return (
    <Badge className={cn("inline-flex items-center gap-1.5", className, sizeClasses[size])}>
      <Icon className={iconSizes[size]} />
      {label}
    </Badge>
  );
}
```

---

## User Flows

### Flow 1: Add New PostgreSQL Server

1. **Entry Point**: Click "Add Server" button on server list page
2. **ServerModal Opens**: Empty form in create mode
3. **User Fills Form**:
   - Server name (required)
   - Host and port (required)
   - Admin username and password (required)
   - SSL mode (default: prefer)
   - Tags (optional)
4. **Test Connection** (recommended but optional):
   - Click "Test Connection" button
   - Backend validates connection
   - Shows success/failure message with version info
5. **Submit**:
   - Form validation
   - API call to create server
   - Optimistic UI update
   - Redirect to server details page
6. **Background**: Health check scheduler picks up new server

**Error Scenarios**:
- Invalid connection details → Show error in modal, don't close
- Network error → Toast notification, keep modal open
- Duplicate server name → Validation error

---

### Flow 2: Create Database via Quick Setup

1. **Entry Point**: Navigate to "Quick Setup" tab on server details
2. **Step 1 - Database**:
   - Enter database name
   - Validation (lowercase, no spaces)
   - Click "Next"
3. **Step 2 - User**:
   - Enter username
   - Enter password (with strength indicator)
   - Click "Next"
4. **Step 3 - Review**:
   - Show summary of what will be created
   - Confirm all details
   - Click "Create Everything"
5. **Backend Processing**:
   - Create database
   - Create user
   - Grant permissions
   - Generate connection string
6. **Step 4 - Success**:
   - Show success message
   - Display connection string with copy button
   - Option to "Create Another"

**Error Scenarios**:
- Database already exists → Show error, go back to step 1
- User already exists → Show error, go back to step 2
- Permission grant fails → Show error, offer to rollback

---

### Flow 3: Manage User Permissions

1. **Entry Point**: Click "Grants" button on user row (Users tab)
2. **Grant List Sheet/Modal Opens**:
   - Shows all databases
   - Highlight databases where user has access
   - Click "Edit Permissions" on a database
3. **GrantEditor Opens**:
   - Shows current permissions (if any)
   - User toggles switches or selects preset
4. **Save**:
   - API call to update grant
   - Optimistic UI update
   - Toast notification
   - Close modal, refresh grant list

**Alternative Flow** (from Databases tab):
1. Click "Grants" on database row
2. Shows all users
3. Click "Edit Permissions" on a user
4. Same GrantEditor experience

---

### Flow 4: Sync Server Data

1. **Entry Point**: Click "Sync from Server" button
2. **Backend Processing**:
   - Connect to PostgreSQL server
   - Query pg_database for all databases
   - Query pg_roles for all users
   - Compare with existing records
3. **UI Updates**:
   - Loading spinner on button
   - Optimistic updates to lists
   - Toast notification: "Found X new databases, Y new users"
4. **Completion**:
   - Update lastSyncedAt timestamp
   - Refresh all tabs
   - Show sync summary

**Error Scenarios**:
- Connection failed → Toast error, keep old data
- Partial sync → Show warning about incomplete sync

---

## State Management

### React Query Configuration

All API calls use React Query for:
- Automatic caching
- Background refetching
- Optimistic updates
- Loading/error states

**Query Keys**:
```tsx
// Server queries
["postgres-servers"]                          // All servers
["postgres-servers", serverId]                // Single server
["postgres-servers", serverId, "databases"]   // Server's databases
["postgres-servers", serverId, "users"]       // Server's users

// Database queries
["postgres-databases", databaseId]            // Single database
["postgres-databases", databaseId, "grants"]  // Database grants

// User queries
["postgres-users", userId]                    // Single user
["postgres-users", userId, "grants"]          // User grants

// Grant queries
["postgres-grants", grantId]                  // Single grant
```

**Mutation Patterns**:
```tsx
// Create server
const createServerMutation = useMutation({
  mutationFn: createPostgresServer,
  onSuccess: () => {
    queryClient.invalidateQueries(["postgres-servers"]);
    toast.success("Server added successfully");
    navigate(`/postgres-server/${data.id}`);
  }
});

// Update grant (optimistic)
const updateGrantMutation = useMutation({
  mutationFn: updateGrant,
  onMutate: async (newGrant) => {
    await queryClient.cancelQueries(["postgres-grants", grantId]);
    const previousGrant = queryClient.getQueryData(["postgres-grants", grantId]);
    queryClient.setQueryData(["postgres-grants", grantId], newGrant);
    return { previousGrant };
  },
  onError: (err, newGrant, context) => {
    queryClient.setQueryData(["postgres-grants", grantId], context.previousGrant);
  },
  onSettled: () => {
    queryClient.invalidateQueries(["postgres-grants", grantId]);
  }
});
```

### Form State

All forms use `react-hook-form` with Zod validation:
```tsx
const form = useForm<FormSchema>({
  resolver: zodResolver(schema),
  defaultValues: {
    // ...defaults
  }
});
```

### Local Component State

Minimal local state for:
- Modal open/close
- Current tab selection
- UI-only toggles (show/hide password, system users filter)
- Wizard step tracking

---

## Accessibility & Responsiveness

### Keyboard Navigation

- **Tab Order**: Logical tab order through all interactive elements
- **Enter/Space**: Submit forms, toggle switches, activate buttons
- **Escape**: Close modals and dialogs
- **Arrow Keys**: Navigate tabs, dropdown menus

### ARIA Labels

```tsx
// Icon-only buttons
<Button aria-label="Edit server">
  <IconEdit className="h-4 w-4" />
</Button>

// Status indicators
<div role="status" aria-live="polite">
  {isLoading && <span className="sr-only">Loading...</span>}
</div>

// Form fields
<Label htmlFor="databaseName">Database Name</Label>
<Input
  id="databaseName"
  aria-required="true"
  aria-invalid={!!errors.databaseName}
  aria-describedby="databaseName-error"
/>
{errors.databaseName && (
  <span id="databaseName-error" className="text-destructive">
    {errors.databaseName.message}
  </span>
)}
```

### Screen Reader Support

- Meaningful heading hierarchy (h1 → h2 → h3)
- Descriptive link text
- Form validation messages announced
- Loading states announced
- Success/error toasts announced

### Responsive Breakpoints

- **Mobile** (< 640px): Single column layouts, stacked forms
- **Tablet** (640px - 1024px): 2-column grids, responsive tables
- **Desktop** (> 1024px): Full grid layouts, side-by-side panels

**Responsive Patterns**:
```tsx
// Grid: 1 column mobile, 2 tablet, 3 desktop
className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"

// Horizontal padding: responsive
className="px-4 lg:px-6"

// Button text: hide on mobile
<IconPlus className="h-4 w-4" />
<span className="hidden md:inline ml-2">Add Server</span>
```

### Touch Targets

- Minimum 44x44px touch targets
- Adequate spacing between interactive elements
- Large tap areas for mobile actions

---

## Implementation Checklist

### Phase 1: Foundation (Week 1-2)

#### Server List Page
- [ ] Create `/postgres-server` route
- [ ] Implement server list layout (header + card grid/table)
- [ ] Build ServerModal component (create/edit)
- [ ] Add ServerModal form validation
- [ ] Implement test connection functionality
- [ ] Build health status badge component
- [ ] Add empty state
- [ ] Add loading state skeletons
- [ ] Implement server CRUD operations (API hooks)
- [ ] Add error handling and toast notifications

#### Server Details - Overview Tab
- [ ] Create `/postgres-server/:serverId` route
- [ ] Build breadcrumb navigation
- [ ] Implement tab navigation component
- [ ] Build overview tab layout
- [ ] Display server information card
- [ ] Display resource summary card
- [ ] Add recent activity placeholder
- [ ] Implement sync functionality
- [ ] Add edit/delete actions

### Phase 2: Database Management (Week 3)

#### Databases Tab
- [ ] Build databases tab layout
- [ ] Implement database list/table view
- [ ] Create DatabaseModal component
- [ ] Add database form validation
- [ ] Implement database creation
- [ ] Add database deletion (with confirmation)
- [ ] Implement sync databases functionality
- [ ] Build database empty state
- [ ] Add database loading states
- [ ] Display database grants count

### Phase 3: User Management (Week 4)

#### Users Tab
- [ ] Build users tab layout
- [ ] Implement user list view
- [ ] Create UserModal component (create/edit)
- [ ] Add user form validation
- [ ] Implement user creation
- [ ] Implement user editing
- [ ] Add change password functionality
- [ ] Implement user deletion (with checks)
- [ ] Add system users filter toggle
- [ ] Implement sync users functionality
- [ ] Build user empty state
- [ ] Add user loading states

### Phase 4: Grant Management (Week 5)

#### Grant Editor
- [ ] Create GrantEditor component
- [ ] Build permission toggle UI
- [ ] Implement permission presets
- [ ] Add grant creation
- [ ] Add grant updating
- [ ] Add revoke all functionality
- [ ] Show grant from database view
- [ ] Show grant from user view
- [ ] Add validation (prevent invalid combinations)
- [ ] Add optimistic updates

### Phase 5: Quick Setup (Week 6)

#### Quick Setup Wizard
- [ ] Create QuickSetupWizard component
- [ ] Build progress indicator
- [ ] Implement Step 1: Database details
- [ ] Implement Step 2: User credentials
- [ ] Implement Step 3: Review
- [ ] Implement Step 4: Success
- [ ] Add wizard navigation (next/previous)
- [ ] Implement form validation per step
- [ ] Call quick setup API endpoint
- [ ] Display connection string with copy
- [ ] Add recent quick setups list
- [ ] Handle errors gracefully

### Phase 6: Polish & Testing (Week 7)

#### UI/UX Polish
- [ ] Review all loading states
- [ ] Review all error states
- [ ] Review all empty states
- [ ] Ensure consistent spacing
- [ ] Verify responsive layouts (mobile/tablet/desktop)
- [ ] Test dark mode appearance
- [ ] Add missing toast notifications
- [ ] Improve error messages (user-friendly)

#### Accessibility
- [ ] Add ARIA labels to all icon buttons
- [ ] Test keyboard navigation
- [ ] Test screen reader experience
- [ ] Ensure proper heading hierarchy
- [ ] Verify color contrast ratios
- [ ] Test with reduced motion preferences

#### Testing
- [ ] Write unit tests for components
- [ ] Write integration tests for user flows
- [ ] Test form validations
- [ ] Test error scenarios
- [ ] Test optimistic updates
- [ ] Cross-browser testing
- [ ] Mobile device testing

---

## Conclusion

This frontend implementation plan provides a comprehensive blueprint for building the PostgreSQL Server Management feature with:

✅ **Consistent Design**: Following established page layout patterns
✅ **Professional UI**: Using Tabler Icons with proper branding
✅ **Great UX**: Progressive disclosure, guided workflows, immediate feedback
✅ **Accessibility**: Keyboard navigation, ARIA labels, screen reader support
✅ **Responsive**: Mobile-first design with breakpoint optimizations
✅ **Maintainable**: Reusable components, centralized state management

The design prioritizes user efficiency through Quick Setup workflows while providing granular control for advanced users through dedicated management interfaces.

**Estimated Timeline**: 7 weeks for full Phase 1 implementation with polish and testing.

**Next Steps**:
1. Review and approve this plan
2. Begin implementation with server list page
3. Iterate based on user feedback during development
4. Conduct usability testing before final release
