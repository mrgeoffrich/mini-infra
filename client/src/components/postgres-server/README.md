# PostgreSQL Server Components

This directory contains React components for PostgreSQL server management features.

## Components

### QuickSetupWizard

A multi-step wizard for quickly creating a complete application database setup (database + user + grants) in one workflow.

#### Features

- **4-Step Wizard Process**:
  1. Database Details - Enter database name
  2. User Credentials - Create username and password
  3. Review - Confirm configuration
  4. Success - Display connection string with copy button

- **Visual Progress Indicator**: Step tracker showing current progress
- **Form Validation**: Per-step validation with Zod schema
- **Password Toggle**: Show/hide password visibility
- **Connection String**: Automatic generation and copy to clipboard
- **Error Handling**: Automatic rollback on failure with user-friendly messages
- **Create Another**: Reset wizard to create additional databases

#### Usage

```tsx
import { QuickSetupWizard } from "@/components/postgres-server";

function QuickSetupTab({ serverId }: { serverId: string }) {
  return (
    <div className="max-w-3xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Quick Application Database Setup</CardTitle>
          <CardDescription>
            Create a database, user, and grant full permissions in one step
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QuickSetupWizard serverId={serverId} />
        </CardContent>
      </Card>
    </div>
  );
}
```

#### Props

- `serverId: string` - ID of the PostgreSQL server to create resources on

#### Validation Rules

- **Database Name**: Lowercase letters, numbers, and underscores only (regex: `/^[a-z0-9_]+$/`)
- **Username**: Lowercase letters, numbers, and underscores only (regex: `/^[a-z0-9_]+$/`)
- **Password**: Minimum 8 characters (recommendation: 12+ characters)

#### Granted Permissions

The quick setup automatically grants the following permissions:
- Database: CONNECT, CREATE, TEMP
- Schema: CREATE, USAGE (on public schema)
- Tables: SELECT, INSERT, UPDATE, DELETE (on all tables)

#### API Integration

Uses the `/api/postgres-server/workflows/create-app-database` endpoint which:
1. Creates the database with UTF8 encoding and template0
2. Creates the user with login permission
3. Grants full permissions to the user on the database
4. Returns a formatted connection string

On error, the workflow automatically rolls back all created resources.

#### Connection String Format

```
postgresql://[username]:[password]@[host]:[port]/[database]?sslmode=[sslmode]
```

---

### GrantEditor

A comprehensive dialog component for managing database grants (permissions) for users on specific databases.

#### Features

- **Permission Presets**: Quick-select common permission patterns
  - No Access: All permissions revoked
  - Read Only: SELECT with CONNECT and USAGE
  - Read/Write: Full CRUD operations (SELECT, INSERT, UPDATE, DELETE)
  - Full Access: All permissions including schema creation

- **Granular Permission Control**: Individual toggles for:
  - Database-level: CONNECT, CREATE, TEMP
  - Schema-level: USAGE, CREATE
  - Table-level: SELECT, INSERT, UPDATE, DELETE

- **Validation**: Automatic warnings for invalid permission combinations (e.g., missing CONNECT)

- **Optimistic Updates**: Instant UI feedback with automatic rollback on errors

#### Usage

```tsx
import { GrantEditor } from "@/components/postgres-server";

function MyComponent() {
  const [grantEditorOpen, setGrantEditorOpen] = useState(false);
  const [selectedDatabase, setSelectedDatabase] = useState<ManagedDatabaseInfo | null>(null);
  const [selectedUser, setSelectedUser] = useState<ManagedDatabaseUserInfo | null>(null);
  const [existingGrant, setExistingGrant] = useState<DatabaseGrantInfo | undefined>(undefined);

  return (
    <>
      <Button onClick={() => {
        setSelectedDatabase(database);
        setSelectedUser(user);
        setExistingGrant(grant); // or undefined for new grant
        setGrantEditorOpen(true);
      }}>
        Edit Permissions
      </Button>

      {selectedDatabase && selectedUser && (
        <GrantEditor
          open={grantEditorOpen}
          onOpenChange={setGrantEditorOpen}
          serverId={serverId}
          database={selectedDatabase}
          user={selectedUser}
          existingGrant={existingGrant}
        />
      )}
    </>
  );
}
```

#### Props

- `open: boolean` - Controls dialog visibility
- `onOpenChange: (open: boolean) => void` - Callback when dialog open state changes
- `serverId: string` - ID of the PostgreSQL server
- `database: ManagedDatabaseInfo` - Database object to grant permissions on
- `user: ManagedDatabaseUserInfo` - User object to grant permissions to
- `existingGrant?: DatabaseGrantInfo` - Optional existing grant for editing (omit for new grant)

#### Integration Points

**From Database View** (client/src/app/postgres-server/[id]/databases.tsx)
```tsx
// Show grant editor when clicking "Grants" button on database row
<Button onClick={() => handleManageGrants(database, user)}>
  <IconShield className="h-4 w-4 mr-1" />
  Grants
</Button>
```

**From User View** (client/src/app/postgres-server/[id]/users.tsx)
```tsx
// Show grant editor when clicking "Grants" button on user row
<Button onClick={() => handleManageGrants(user, database)}>
  <IconShield className="h-4 w-4 mr-1" />
  Grants
</Button>
```

#### API Hooks

The component uses these React Query hooks from `@/hooks/use-database-grants`:

- `useCreateDatabaseGrant(serverId)` - Create new grant
- `useUpdateDatabaseGrant()` - Update existing grant (with optimistic updates)
- `useDeleteDatabaseGrant(serverId)` - Delete grant (revoke all)

#### Permission Preset Mappings

```typescript
{
  none: { all: false },
  readonly: {
    canConnect: true,
    canUsageSchema: true,
    canSelect: true,
    // all others: false
  },
  readwrite: {
    canConnect: true,
    canTemp: true,
    canUsageSchema: true,
    canSelect: true,
    canInsert: true,
    canUpdate: true,
    canDelete: true,
    // canCreate, canCreateSchema: false
  },
  full: { all: true }
}
```
