# Azure Multi-Tenant Wizard - Implementation Plan

## Overview

This document outlines the implementation plan for a multi-tenant Azure resource provisioning wizard that allows users to authenticate with their Azure accounts and automatically provision infrastructure resources (resource groups, storage accounts, key vaults, and app registrations) without requiring any Azure AD/Entra ID configuration knowledge.

## How Multi-Tenant Apps Work

### The Key Insight
You create **ONE** app registration in **YOUR** Azure tenant, configure it as multi-tenant, and then **any user from any Azure organization** can consent to it and use it - without needing to create or configure anything in Azure AD themselves.

```
┌─────────────────────────────────────────────────────────┐
│  YOUR Azure Tenant (Developer)                          │
│                                                          │
│  ┌───────────────────────────────────────────────┐     │
│  │  Multi-Tenant App Registration                │     │
│  │  Name: "Mini Infra"                           │     │
│  │  Client ID: abc-123-def                       │     │
│  │  Client Secret: [your secret]                 │     │
│  │  Supported Account Types: Multi-tenant        │     │
│  └───────────────────────────────────────────────┘     │
│                                                          │
└─────────────────────────────────────────────────────────┘
                          │
                          │ Users from ANY tenant can consent
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        v                 v                 v
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ End User's   │  │ End User's   │  │ End User's   │
│ Azure Tenant │  │ Azure Tenant │  │ Azure Tenant │
│      A       │  │      B       │  │      C       │
└──────────────┘  └──────────────┘  └──────────────┘
```

## Architecture

### Authentication Flow

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│             │         │              │         │             │
│  Mini Infra │────────>│  Azure AD    │────────>│   User      │
│     App     │  OAuth  │  OAuth 2.0   │ Consent │ Authenticates│
│             │<────────│   Endpoint   │<────────│             │
└─────────────┘  Token  └──────────────┘         └─────────────┘
       │
       │ Access Token (with delegated permissions)
       v
┌─────────────────────────────────────┐
│  Azure Resource Manager (ARM) API  │
│  - Create Resource Groups           │
│  - Create Storage Accounts          │
│  - Create Key Vaults                │
│  - Create App Registrations         │
└─────────────────────────────────────┘
```

## Implementation Steps

### Step 1: Create Multi-Tenant App Registration

You (the developer) do this ONCE in your own Azure tenant:

#### Using Azure CLI

```bash
az ad app create \
  --display-name "Mini Infra Resource Provisioner" \
  --sign-in-audience "AzureADMultipleOrgs" \
  --web-redirect-uris "http://localhost:5000/auth/azure/callback" \
                      "https://mini.blingtowers.com/auth/azure/callback"
```

#### Using Azure Portal

1. Go to **Azure Portal** → **Azure Active Directory** → **App registrations** → **New registration**
2. **Name**: "Mini Infra Resource Provisioner"
3. **Supported account types**: Select **"Accounts in any organizational directory (Any Azure AD directory - Multitenant)"** ← This is the key!
4. **Redirect URI**: `http://localhost:5000/auth/azure/callback`

### Step 2: Configure API Permissions

In your app registration, add these **delegated permissions**:

```
Azure Service Management
  └─ user_impersonation (delegated)

Microsoft Graph
  └─ Application.ReadWrite.All (delegated)
  └─ Directory.ReadWrite.All (delegated)
  └─ User.Read (delegated)
```

**Important**: Don't request admin consent here - let individual users consent when they first use your app.

### Step 3: Create a Client Secret

In your app registration:
- Go to **Certificates & secrets** → **New client secret**
- Copy the secret value (you'll put this in your `.env`)

### Step 4: Configure Mini Infra Environment

Add to `server/.env`:

```bash
# Azure Multi-Tenant App Configuration
AZURE_CLIENT_ID=abc-123-def-456  # From your app registration
AZURE_CLIENT_SECRET=your_secret_here
AZURE_TENANT_ID=common  # Special value for multi-tenant apps
AZURE_REDIRECT_URI=http://localhost:5000/auth/azure/callback
```

**Note**: Use `common` as the tenant ID for multi-tenant apps - this allows users from any tenant to authenticate.

## End-User Experience

### 1. User Clicks "Connect to Azure" in Mini Infra

```typescript
// Frontend button
<Button onClick={handleConnectAzure}>
  Connect to My Azure Subscription
</Button>
```

### 2. User is Redirected to Microsoft Login

They see the standard Microsoft login page - nothing scary or technical.

### 3. User Sees a Consent Screen

Microsoft shows them:

```
┌─────────────────────────────────────────────────┐
│  Mini Infra Resource Provisioner                │
│  wants to:                                       │
│                                                  │
│  ✓ Access Azure Service Management as you      │
│  ✓ Create and manage applications              │
│  ✓ Read and write directory data               │
│  ✓ Sign you in and read your profile           │
│                                                  │
│  This app is published by: MiniInfra.com        │
│                                                  │
│         [Cancel]              [Accept]          │
└─────────────────────────────────────────────────┘
```

### 4. User Accepts - Done!

Your app now has permission to create resources in **their** Azure subscription, using **their** credentials, without them needing to configure anything.

## Backend Implementation

### Database Schema

```prisma
model AzureConnection {
  id                String   @id @default(cuid())
  userId            String
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Each user can connect multiple Azure tenants/subscriptions
  tenantId          String   // The user's Azure tenant ID
  subscriptionId    String?  // Optional: track which subscription they're using
  subscriptionName  String?

  accessToken       String   // Encrypted - scoped to user's tenant
  refreshToken      String   // Encrypted
  tokenExpiry       DateTime

  // Metadata
  userPrincipalName String?  // User's Azure email
  displayName       String?  // User's display name

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([userId, tenantId])
  @@index([userId])
}

model AzureWizardExecution {
  id                String   @id @default(cuid())
  userId            String
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  status            String   // pending, in_progress, completed, failed

  // Wizard inputs
  resourceGroupName String
  location          String
  storageAccountName String
  keyVaultName      String
  appRegistrationName String

  // Created resource IDs
  resourceGroupId   String?
  storageAccountId  String?
  keyVaultId        String?
  appRegistrationId String?

  errorLog          String?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([userId])
  @@index([status])
}
```

### OAuth Routes Implementation

```typescript
// server/src/routes/azure-auth.ts
import express from 'express';
import { requireAuth } from '../middleware/auth';
import axios from 'axios';
import crypto from 'crypto';

const router = express.Router();

// Step 1: Initiate OAuth flow
router.get('/auth/azure/login', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');

  // Store state in session for CSRF protection
  req.session.azureOAuthState = state;

  const authUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
    `client_id=${process.env.AZURE_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(process.env.AZURE_REDIRECT_URI!)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(
      'https://management.azure.com/user_impersonation ' +
      'https://graph.microsoft.com/Application.ReadWrite.All ' +
      'https://graph.microsoft.com/Directory.ReadWrite.All ' +
      'openid profile email'
    )}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// Step 2: Handle callback
router.get('/auth/azure/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;

  // Verify state for CSRF protection
  if (state !== req.session.azureOAuthState) {
    return res.status(400).send('Invalid state parameter');
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/common/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID!,
        client_secret: process.env.AZURE_CLIENT_SECRET!,
        code: code as string,
        redirect_uri: process.env.AZURE_REDIRECT_URI!,
        grant_type: 'authorization_code',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Decode token to get user's tenant ID
    const tokenParts = access_token.split('.');
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
    const userTenantId = payload.tid;

    // Get user's subscriptions
    const subscriptions = await listUserSubscriptions(access_token);

    // Store in database (encrypted)
    await prisma.azureConnection.create({
      data: {
        userId: req.user!.id,
        tenantId: userTenantId,
        accessToken: encrypt(access_token),
        refreshToken: encrypt(refresh_token),
        tokenExpiry: new Date(Date.now() + expires_in * 1000),
      }
    });

    res.redirect('/azure-wizard?step=select-subscription');
  } catch (error) {
    logger.error('Azure OAuth callback error:', error);
    res.status(500).send('Authentication failed');
  }
});

export default router;
```

### Token Management Service

```typescript
// server/src/services/azure/azure-token-service.ts
export class AzureTokenService {
  async getValidToken(userId: string): Promise<string> {
    const connection = await prisma.azureConnection.findFirst({
      where: { userId }
    });

    if (!connection) {
      throw new Error('No Azure connection found');
    }

    // Check if token is still valid (with 5 min buffer)
    if (connection.tokenExpiry > new Date(Date.now() + 5 * 60 * 1000)) {
      return decrypt(connection.accessToken);
    }

    // Refresh the token using the user's tenant ID
    const tokenResponse = await axios.post(
      `https://login.microsoftonline.com/${connection.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID!,
        client_secret: process.env.AZURE_CLIENT_SECRET!,
        grant_type: 'refresh_token',
        refresh_token: decrypt(connection.refreshToken),
        scope: 'https://management.azure.com/user_impersonation offline_access',
      })
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Update stored tokens
    await prisma.azureConnection.update({
      where: { id: connection.id },
      data: {
        accessToken: encrypt(access_token),
        refreshToken: encrypt(refresh_token),
        tokenExpiry: new Date(Date.now() + expires_in * 1000),
      }
    });

    return access_token;
  }
}
```

### Backend Service Structure

```typescript
// server/src/services/azure/
├── azure-auth-service.ts      // Handle OAuth flow and token refresh
├── azure-arm-client.ts        // ARM API wrapper
├── azure-graph-client.ts      // Microsoft Graph API wrapper
├── azure-wizard-service.ts    // Orchestrate wizard steps
└── azure-resource-provisioner.ts // Create resources

// Example service
class AzureWizardService {
  async executeWizard(userId: string, params: WizardParams) {
    // 1. Get user's Azure access token
    const token = await this.getAccessToken(userId);

    // 2. Create resource group
    const rg = await this.armClient.createResourceGroup(token, params);

    // 3. Create storage account
    const storage = await this.armClient.createStorageAccount(token, params);

    // 4. Create key vault
    const kv = await this.armClient.createKeyVault(token, params);

    // 5. Create app registration
    const app = await this.graphClient.createAppRegistration(token, params);

    // 6. Assign key vault permissions to app
    await this.armClient.assignKeyVaultPermissions(token, kv.id, app.id);

    return { rg, storage, kv, app };
  }
}
```

## Frontend Implementation

### Wizard Flow Structure

```typescript
// client/src/app/azure-wizard/
├── step1-authenticate.tsx     // OAuth login to Azure
├── step2-select-subscription.tsx
├── step3-configure-resources.tsx
├── step4-review.tsx
├── step5-provision.tsx        // Execute with progress tracking
└── wizard-context.tsx
```

## Required Azure Permissions

### API Permissions Needed

1. **Azure Resource Manager (ARM)**
   - `user_impersonation` (delegated) - To create resources on behalf of user

2. **Microsoft Graph**
   - `Application.ReadWrite.All` (delegated) - To create app registrations
   - `Directory.ReadWrite.All` (delegated) - To create service principals and assign permissions
   - `User.Read` (delegated) - To read user profile

### Azure RBAC Role Requirements

The authenticated user must have these Azure RBAC roles on their subscription:

- **Contributor** or **Owner** role - To create resource groups, storage accounts, key vaults
- **Application Administrator** or **Cloud Application Administrator** - To create app registrations in Azure AD

## Key Advantages

✅ **User-Friendly**: End users just log in with their Azure credentials - no technical setup
✅ **Secure**: Uses OAuth 2.0 delegated permissions - you never see their password
✅ **Scoped**: Each user's tokens only work for their own subscriptions
✅ **Standard Pattern**: This is how ALL third-party Azure integrations work
✅ **Scalable**: One app registration supports unlimited users across unlimited tenants

## Limitations & Considerations

### 1. Users Still Need Azure Permissions

Even though they don't need to configure Azure AD, they still need:
- An active Azure subscription
- **Contributor** or **Owner** role on the subscription
- **Application Administrator** role in their tenant (to create app registrations)

### 2. Consent May Require Admin

Some organizations block users from consenting to new apps. If this happens:
- The user sees "Need admin approval" message
- They need to ask their IT admin to consent once
- After admin consents, all users in that org can use it

### 3. Refresh Token Lifetime

Refresh tokens can expire after 90 days of inactivity or if the user changes their password. You'll need to handle re-authentication.

## Security Considerations

1. **Token Storage**: Encrypt access and refresh tokens using `crypto-js` (already in your stack)
2. **Token Rotation**: Implement automatic refresh before expiry
3. **Least Privilege**: Only request permissions actually needed
4. **Audit Logging**: Log all resource creation activities
5. **User Consent**: Make it clear what permissions are being requested

## Challenges & Solutions

### Challenge 1: User doesn't have sufficient Azure permissions
**Solution**: Pre-flight check to validate user's RBAC roles before starting wizard

### Challenge 2: Token expiry during long-running provisioning
**Solution**: Implement token refresh middleware that auto-refreshes before API calls

### Challenge 3: Partial failure (some resources created, others failed)
**Solution**: Implement rollback logic or allow resuming from last successful step

### Challenge 4: Multi-tenant support
**Solution**: Store tenant-specific tokens and allow users to connect multiple Azure subscriptions

## Next Steps

1. Create Azure AD App Registration for Mini Infra (manual step)
2. Add npm dependencies: `axios`, `@azure/arm-resources`, `@azure/arm-storage`, `@azure/arm-keyvault`, `@azure/identity`
3. Implement database migrations for new schema
4. Build OAuth routes and token management service
5. Implement Azure ARM and Graph API clients
6. Build wizard service layer
7. Create frontend wizard UI with step-by-step flow
8. Add comprehensive error handling and logging
9. Implement pre-flight permission checks
10. Add audit logging for all resource creation activities

## Alignment with Mini Infra

This wizard fits perfectly with Mini Infra's mission:
- Automates infrastructure provisioning
- Integrates with existing Azure Blob Storage functionality
- Can be extended to provision other Azure resources (VMs, databases, etc.)
- Fits the self-service infrastructure management paradigm
- Provides value to users who want to quickly spin up Azure infrastructure
