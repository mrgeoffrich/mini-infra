-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "googleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "permissions" TEXT,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "containerSortField" TEXT DEFAULT 'name',
    "containerSortOrder" TEXT DEFAULT 'asc',
    "containerFilters" JSONB,
    "containerColumns" JSONB,
    "timezone" TEXT DEFAULT 'UTC',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "container_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "data" JSONB NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "isEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastValidatedAt" DATETIME,
    "validationStatus" TEXT,
    "validationMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "connectivity_status" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseTimeMs" BIGINT,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "lastSuccessfulAt" DATETIME,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkInitiatedBy" TEXT,
    "metadata" TEXT
);

-- CreateTable
CREATE TABLE "postgres_databases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "connectionString" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "sslMode" TEXT NOT NULL DEFAULT 'prefer',
    "tags" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastHealthCheck" DATETIME,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown'
);

-- CreateTable
CREATE TABLE "backup_configurations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "schedule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "azureContainerName" TEXT NOT NULL,
    "azurePathPrefix" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "backupFormat" TEXT NOT NULL DEFAULT 'custom',
    "compressionLevel" INTEGER NOT NULL DEFAULT 6,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastBackupAt" DATETIME,
    "nextScheduledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "backup_configurations_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "postgres_databases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backup_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "sizeBytes" BIGINT,
    "azureBlobUrl" TEXT,
    "errorMessage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "metadata" TEXT,
    CONSTRAINT "backup_operations_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "postgres_databases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "restore_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "backupUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "restore_operations_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "postgres_databases" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "self_backups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL,
    "filePath" TEXT,
    "azureBlobUrl" TEXT,
    "azureContainerName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "userId" TEXT,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "environments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "networkType" TEXT NOT NULL DEFAULT 'local',
    "tunnelId" TEXT,
    "tunnelServiceUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "environment_networks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'custom',
    "driver" TEXT NOT NULL DEFAULT 'bridge',
    "options" JSONB,
    "dockerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environment_networks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "host_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "health" TEXT NOT NULL DEFAULT 'unknown',
    "config" JSONB,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "lastError" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "haproxy_frontends" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "frontendType" TEXT NOT NULL DEFAULT 'shared',
    "containerName" TEXT,
    "containerId" TEXT,
    "containerPort" INTEGER,
    "environmentId" TEXT,
    "frontendName" TEXT NOT NULL,
    "backendName" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "bindPort" INTEGER NOT NULL DEFAULT 80,
    "bindAddress" TEXT NOT NULL DEFAULT '*',
    "useSSL" BOOLEAN NOT NULL DEFAULT false,
    "tlsCertificateId" TEXT,
    "sslBindPort" INTEGER NOT NULL DEFAULT 443,
    "isSharedFrontend" BOOLEAN NOT NULL DEFAULT false,
    "sharedFrontendId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_frontends_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "haproxy_frontends_tlsCertificateId_fkey" FOREIGN KEY ("tlsCertificateId") REFERENCES "tls_certificates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "haproxy_routes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sharedFrontendId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "aclName" TEXT NOT NULL,
    "backendName" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT NOT NULL,
    "manualFrontendId" TEXT,
    "useSSL" BOOLEAN NOT NULL DEFAULT false,
    "tlsCertificateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_routes_sharedFrontendId_fkey" FOREIGN KEY ("sharedFrontendId") REFERENCES "haproxy_frontends" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "haproxy_backends" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'http',
    "balanceAlgorithm" TEXT NOT NULL DEFAULT 'roundrobin',
    "checkTimeout" INTEGER,
    "connectTimeout" INTEGER,
    "serverTimeout" INTEGER,
    "sourceType" TEXT NOT NULL,
    "manualFrontendId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_backends_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "haproxy_servers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "backendId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "check" TEXT NOT NULL DEFAULT 'enabled',
    "checkPath" TEXT,
    "inter" INTEGER,
    "rise" INTEGER,
    "fall" INTEGER,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maintenance" BOOLEAN NOT NULL DEFAULT false,
    "containerId" TEXT,
    "containerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_servers_backendId_fkey" FOREIGN KEY ("backendId") REFERENCES "haproxy_backends" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "registry_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "registryUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "tokenExpiresAt" DATETIME,
    "lastValidatedAt" DATETIME,
    "validationStatus" TEXT,
    "validationMessage" TEXT
);

-- CreateTable
CREATE TABLE "postgres_servers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 5432,
    "adminUsername" TEXT NOT NULL,
    "connectionString" TEXT NOT NULL,
    "sslMode" TEXT NOT NULL DEFAULT 'prefer',
    "tags" TEXT,
    "healthStatus" TEXT NOT NULL DEFAULT 'unknown',
    "lastHealthCheck" DATETIME,
    "serverVersion" TEXT,
    "linkedContainerId" TEXT,
    "linkedContainerName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    CONSTRAINT "postgres_servers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "managed_databases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "encoding" TEXT NOT NULL DEFAULT 'UTF8',
    "collation" TEXT,
    "template" TEXT NOT NULL DEFAULT 'template0',
    "sizeBytes" BIGINT,
    "connectionLimit" INTEGER NOT NULL DEFAULT -1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSyncedAt" DATETIME,
    CONSTRAINT "managed_databases_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "postgres_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "managed_database_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "canLogin" BOOLEAN NOT NULL DEFAULT true,
    "isSuperuser" BOOLEAN NOT NULL DEFAULT false,
    "connectionLimit" INTEGER NOT NULL DEFAULT -1,
    "passwordHash" TEXT,
    "passwordSetAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastSyncedAt" DATETIME,
    CONSTRAINT "managed_database_users_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "postgres_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "database_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "databaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "canConnect" BOOLEAN NOT NULL DEFAULT true,
    "canCreate" BOOLEAN NOT NULL DEFAULT false,
    "canTemp" BOOLEAN NOT NULL DEFAULT false,
    "canCreateSchema" BOOLEAN NOT NULL DEFAULT false,
    "canUsageSchema" BOOLEAN NOT NULL DEFAULT true,
    "canSelect" BOOLEAN NOT NULL DEFAULT true,
    "canInsert" BOOLEAN NOT NULL DEFAULT true,
    "canUpdate" BOOLEAN NOT NULL DEFAULT true,
    "canDelete" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "database_grants_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "managed_databases" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "database_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "managed_database_users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "tls_certificates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domains" TEXT NOT NULL,
    "primaryDomain" TEXT NOT NULL,
    "certificateType" TEXT NOT NULL DEFAULT 'ACME',
    "acmeProvider" TEXT,
    "acmeAccountId" TEXT,
    "acmeOrderUrl" TEXT,
    "blobContainerName" TEXT,
    "blobName" TEXT,
    "issuer" TEXT,
    "serialNumber" TEXT,
    "fingerprint" TEXT,
    "issuedAt" DATETIME NOT NULL,
    "notBefore" DATETIME NOT NULL,
    "notAfter" DATETIME NOT NULL,
    "renewAfter" DATETIME NOT NULL,
    "lastRenewedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "renewalDaysBeforeExpiry" INTEGER NOT NULL DEFAULT 30,
    "haproxyFrontendNames" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "tls_certificate_renewals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "certificateId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "acmeOrderUrl" TEXT,
    "acmeChallengeType" TEXT,
    "dnsRecordName" TEXT,
    "dnsRecordValue" TEXT,
    "blobETag" TEXT,
    "haproxyReloadMethod" TEXT,
    "haproxyReloadSuccess" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "errorDetails" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "metadata" TEXT,
    CONSTRAINT "tls_certificate_renewals_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "tls_certificates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "acme_accounts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountUrl" TEXT NOT NULL,
    "blobContainerName" TEXT,
    "blobName" TEXT,
    "keyAlgorithm" TEXT NOT NULL DEFAULT 'RSA-2048',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "termsOfServiceUrl" TEXT,
    "agreedToTermsAt" DATETIME,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "permission_presets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "permissions" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "user_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "eventCategory" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "userId" TEXT,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "resourceId" TEXT,
    "resourceType" TEXT,
    "resourceName" TEXT,
    "description" TEXT,
    "metadata" TEXT,
    "resultSummary" TEXT,
    "errorMessage" TEXT,
    "errorDetails" TEXT,
    "logs" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "volume_inspections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inspectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "fileCount" INTEGER,
    "totalSize" BIGINT,
    "files" TEXT,
    "stdout" TEXT,
    "stderr" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "volume_file_contents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "volumeName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "agent_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sdkSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "agent_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_conversation_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "toolId" TEXT,
    "toolName" TEXT,
    "toolInput" TEXT,
    "toolOutput" TEXT,
    "success" BOOLEAN,
    "cost" REAL,
    "duration" REAL,
    "turns" INTEGER,
    "sequence" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_conversation_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "self_updates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetTag" TEXT NOT NULL,
    "fullImageRef" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "progress" INTEGER,
    "errorMessage" TEXT,
    "sidecarId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "durationMs" INTEGER,
    "triggeredBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "stacks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "environmentId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'undeployed',
    "lastAppliedVersion" INTEGER,
    "lastAppliedAt" DATETIME,
    "lastAppliedSnapshot" JSONB,
    "builtinVersion" INTEGER,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "parameters" JSONB,
    "parameterValues" JSONB,
    "networks" JSONB NOT NULL,
    "volumes" JSONB NOT NULL,
    "tlsCertificates" JSONB,
    "dnsRecords" JSONB,
    "tunnelIngress" JSONB,
    "resourceOutputs" JSONB,
    "resourceInputs" JSONB,
    "removedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stacks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stacks_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "stack_templates" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerTag" TEXT NOT NULL,
    "containerConfig" JSONB NOT NULL,
    "configFiles" JSONB,
    "initCommands" JSONB,
    "dependsOn" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "routing" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stack_services_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "version" INTEGER,
    "status" TEXT NOT NULL,
    "duration" INTEGER,
    "serviceResults" JSONB,
    "resourceResults" JSONB,
    "error" TEXT,
    "triggeredBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stack_deployments_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stackId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "fqdn" TEXT NOT NULL,
    "externalId" TEXT,
    "externalState" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stack_resources_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "infra_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "environmentId" TEXT,
    "stackId" TEXT,
    "name" TEXT NOT NULL,
    "dockerId" TEXT,
    "metadata" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "infra_resources_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "infra_resources_stackId_fkey" FOREIGN KEY ("stackId") REFERENCES "stacks" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "category" TEXT,
    "environmentId" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "draftVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "stack_templates_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stack_templates_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "stack_template_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stack_templates_draftVersionId_fkey" FOREIGN KEY ("draftVersionId") REFERENCES "stack_template_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_template_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "parameters" JSONB NOT NULL,
    "defaultParameterValues" JSONB NOT NULL,
    "networkTypeDefaults" JSONB NOT NULL,
    "resourceOutputs" JSONB,
    "resourceInputs" JSONB,
    "networks" JSONB NOT NULL,
    "volumes" JSONB NOT NULL,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "stack_template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "stack_templates" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_template_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerTag" TEXT NOT NULL,
    "containerConfig" JSONB NOT NULL,
    "initCommands" JSONB,
    "dependsOn" JSONB NOT NULL,
    "order" INTEGER NOT NULL,
    "routing" JSONB,
    CONSTRAINT "stack_template_services_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "stack_template_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack_template_config_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "volumeName" TEXT NOT NULL,
    "mountPath" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "permissions" TEXT,
    "owner" TEXT,
    CONSTRAINT "stack_template_config_files_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "stack_template_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dns_cache_zones" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cloudflareZoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT NOT NULL,
    "nameServers" TEXT NOT NULL,
    "createdOn" TEXT,
    "modifiedOn" TEXT,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "dns_cache_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cloudflareRecordId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "ttl" INTEGER NOT NULL,
    "proxied" BOOLEAN NOT NULL DEFAULT false,
    "proxiable" BOOLEAN NOT NULL DEFAULT true,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "zoneName" TEXT NOT NULL,
    "createdOn" TEXT,
    "modifiedOn" TEXT,
    "cachedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dns_cache_records_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "dns_cache_zones" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleId_key" ON "users"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_key" ON "api_keys"("key");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE INDEX "container_cache_expiresAt_idx" ON "container_cache"("expiresAt");

-- CreateIndex
CREATE INDEX "system_settings_category_idx" ON "system_settings"("category");

-- CreateIndex
CREATE INDEX "system_settings_validationStatus_idx" ON "system_settings"("validationStatus");

-- CreateIndex
CREATE INDEX "system_settings_isActive_idx" ON "system_settings"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_category_key_key" ON "system_settings"("category", "key");

-- CreateIndex
CREATE INDEX "connectivity_status_service_idx" ON "connectivity_status"("service");

-- CreateIndex
CREATE INDEX "connectivity_status_status_idx" ON "connectivity_status"("status");

-- CreateIndex
CREATE INDEX "connectivity_status_checkedAt_idx" ON "connectivity_status"("checkedAt");

-- CreateIndex
CREATE INDEX "connectivity_status_service_checkedAt_idx" ON "connectivity_status"("service", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "postgres_databases_name_key" ON "postgres_databases"("name");

-- CreateIndex
CREATE UNIQUE INDEX "backup_configurations_databaseId_key" ON "backup_configurations"("databaseId");

-- CreateIndex
CREATE INDEX "backup_configurations_databaseId_idx" ON "backup_configurations"("databaseId");

-- CreateIndex
CREATE INDEX "backup_operations_databaseId_status_idx" ON "backup_operations"("databaseId", "status");

-- CreateIndex
CREATE INDEX "backup_operations_startedAt_idx" ON "backup_operations"("startedAt");

-- CreateIndex
CREATE INDEX "restore_operations_databaseId_status_idx" ON "restore_operations"("databaseId", "status");

-- CreateIndex
CREATE INDEX "self_backups_status_idx" ON "self_backups"("status");

-- CreateIndex
CREATE INDEX "self_backups_startedAt_idx" ON "self_backups"("startedAt");

-- CreateIndex
CREATE INDEX "self_backups_azureContainerName_idx" ON "self_backups"("azureContainerName");

-- CreateIndex
CREATE UNIQUE INDEX "environments_name_key" ON "environments"("name");

-- CreateIndex
CREATE INDEX "environments_type_idx" ON "environments"("type");

-- CreateIndex
CREATE INDEX "environments_networkType_idx" ON "environments"("networkType");

-- CreateIndex
CREATE INDEX "environment_networks_environmentId_idx" ON "environment_networks"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "environment_networks_environmentId_name_key" ON "environment_networks"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "environment_networks_environmentId_purpose_key" ON "environment_networks"("environmentId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "host_services_serviceName_key" ON "host_services"("serviceName");

-- CreateIndex
CREATE INDEX "host_services_status_idx" ON "host_services"("status");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_frontends_frontendName_key" ON "haproxy_frontends"("frontendName");

-- CreateIndex
CREATE INDEX "haproxy_frontends_frontendName_idx" ON "haproxy_frontends"("frontendName");

-- CreateIndex
CREATE INDEX "haproxy_frontends_hostname_idx" ON "haproxy_frontends"("hostname");

-- CreateIndex
CREATE INDEX "haproxy_frontends_status_idx" ON "haproxy_frontends"("status");

-- CreateIndex
CREATE INDEX "haproxy_frontends_tlsCertificateId_idx" ON "haproxy_frontends"("tlsCertificateId");

-- CreateIndex
CREATE INDEX "haproxy_frontends_frontendType_idx" ON "haproxy_frontends"("frontendType");

-- CreateIndex
CREATE INDEX "haproxy_frontends_environmentId_idx" ON "haproxy_frontends"("environmentId");

-- CreateIndex
CREATE INDEX "haproxy_frontends_isSharedFrontend_idx" ON "haproxy_frontends"("isSharedFrontend");

-- CreateIndex
CREATE INDEX "haproxy_routes_sharedFrontendId_idx" ON "haproxy_routes"("sharedFrontendId");

-- CreateIndex
CREATE INDEX "haproxy_routes_hostname_idx" ON "haproxy_routes"("hostname");

-- CreateIndex
CREATE INDEX "haproxy_routes_status_idx" ON "haproxy_routes"("status");

-- CreateIndex
CREATE INDEX "haproxy_routes_sourceType_idx" ON "haproxy_routes"("sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_routes_sharedFrontendId_hostname_key" ON "haproxy_routes"("sharedFrontendId", "hostname");

-- CreateIndex
CREATE INDEX "haproxy_backends_environmentId_idx" ON "haproxy_backends"("environmentId");

-- CreateIndex
CREATE INDEX "haproxy_backends_status_idx" ON "haproxy_backends"("status");

-- CreateIndex
CREATE INDEX "haproxy_backends_sourceType_idx" ON "haproxy_backends"("sourceType");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_backends_name_environmentId_key" ON "haproxy_backends"("name", "environmentId");

-- CreateIndex
CREATE INDEX "haproxy_servers_backendId_idx" ON "haproxy_servers"("backendId");

-- CreateIndex
CREATE INDEX "haproxy_servers_status_idx" ON "haproxy_servers"("status");

-- CreateIndex
CREATE INDEX "haproxy_servers_containerId_idx" ON "haproxy_servers"("containerId");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_servers_name_backendId_key" ON "haproxy_servers"("name", "backendId");

-- CreateIndex
CREATE UNIQUE INDEX "registry_credentials_registryUrl_key" ON "registry_credentials"("registryUrl");

-- CreateIndex
CREATE UNIQUE INDEX "postgres_servers_name_key" ON "postgres_servers"("name");

-- CreateIndex
CREATE INDEX "postgres_servers_userId_idx" ON "postgres_servers"("userId");

-- CreateIndex
CREATE INDEX "postgres_servers_healthStatus_idx" ON "postgres_servers"("healthStatus");

-- CreateIndex
CREATE INDEX "managed_databases_serverId_idx" ON "managed_databases"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "managed_databases_serverId_databaseName_key" ON "managed_databases"("serverId", "databaseName");

-- CreateIndex
CREATE INDEX "managed_database_users_serverId_idx" ON "managed_database_users"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "managed_database_users_serverId_username_key" ON "managed_database_users"("serverId", "username");

-- CreateIndex
CREATE INDEX "database_grants_databaseId_idx" ON "database_grants"("databaseId");

-- CreateIndex
CREATE INDEX "database_grants_userId_idx" ON "database_grants"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "database_grants_databaseId_userId_key" ON "database_grants"("databaseId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tls_certificates_blobName_key" ON "tls_certificates"("blobName");

-- CreateIndex
CREATE UNIQUE INDEX "tls_certificates_fingerprint_key" ON "tls_certificates"("fingerprint");

-- CreateIndex
CREATE INDEX "tls_certificates_primaryDomain_idx" ON "tls_certificates"("primaryDomain");

-- CreateIndex
CREATE INDEX "tls_certificates_status_idx" ON "tls_certificates"("status");

-- CreateIndex
CREATE INDEX "tls_certificates_renewAfter_idx" ON "tls_certificates"("renewAfter");

-- CreateIndex
CREATE INDEX "tls_certificates_notAfter_idx" ON "tls_certificates"("notAfter");

-- CreateIndex
CREATE INDEX "tls_certificate_renewals_certificateId_idx" ON "tls_certificate_renewals"("certificateId");

-- CreateIndex
CREATE INDEX "tls_certificate_renewals_status_idx" ON "tls_certificate_renewals"("status");

-- CreateIndex
CREATE INDEX "tls_certificate_renewals_startedAt_idx" ON "tls_certificate_renewals"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "acme_accounts_email_key" ON "acme_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "acme_accounts_accountUrl_key" ON "acme_accounts"("accountUrl");

-- CreateIndex
CREATE UNIQUE INDEX "acme_accounts_blobName_key" ON "acme_accounts"("blobName");

-- CreateIndex
CREATE INDEX "acme_accounts_email_idx" ON "acme_accounts"("email");

-- CreateIndex
CREATE INDEX "acme_accounts_provider_idx" ON "acme_accounts"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "permission_presets_name_key" ON "permission_presets"("name");

-- CreateIndex
CREATE INDEX "user_events_eventType_idx" ON "user_events"("eventType");

-- CreateIndex
CREATE INDEX "user_events_eventCategory_idx" ON "user_events"("eventCategory");

-- CreateIndex
CREATE INDEX "user_events_userId_idx" ON "user_events"("userId");

-- CreateIndex
CREATE INDEX "user_events_status_idx" ON "user_events"("status");

-- CreateIndex
CREATE INDEX "user_events_startedAt_idx" ON "user_events"("startedAt");

-- CreateIndex
CREATE INDEX "user_events_resourceType_resourceId_idx" ON "user_events"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "user_events_expiresAt_idx" ON "user_events"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "volume_inspections_volumeName_key" ON "volume_inspections"("volumeName");

-- CreateIndex
CREATE INDEX "volume_inspections_volumeName_idx" ON "volume_inspections"("volumeName");

-- CreateIndex
CREATE INDEX "volume_inspections_status_idx" ON "volume_inspections"("status");

-- CreateIndex
CREATE INDEX "volume_inspections_inspectedAt_idx" ON "volume_inspections"("inspectedAt");

-- CreateIndex
CREATE INDEX "volume_file_contents_volumeName_idx" ON "volume_file_contents"("volumeName");

-- CreateIndex
CREATE INDEX "volume_file_contents_fetchedAt_idx" ON "volume_file_contents"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "volume_file_contents_volumeName_filePath_key" ON "volume_file_contents"("volumeName", "filePath");

-- CreateIndex
CREATE INDEX "agent_conversations_userId_idx" ON "agent_conversations"("userId");

-- CreateIndex
CREATE INDEX "agent_conversations_userId_updatedAt_idx" ON "agent_conversations"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "agent_conversations_deletedAt_idx" ON "agent_conversations"("deletedAt");

-- CreateIndex
CREATE INDEX "agent_conversation_messages_conversationId_idx" ON "agent_conversation_messages"("conversationId");

-- CreateIndex
CREATE INDEX "agent_conversation_messages_conversationId_sequence_idx" ON "agent_conversation_messages"("conversationId", "sequence");

-- CreateIndex
CREATE INDEX "self_updates_state_idx" ON "self_updates"("state");

-- CreateIndex
CREATE INDEX "self_updates_startedAt_idx" ON "self_updates"("startedAt");

-- CreateIndex
CREATE INDEX "stacks_environmentId_idx" ON "stacks"("environmentId");

-- CreateIndex
CREATE INDEX "stacks_status_idx" ON "stacks"("status");

-- CreateIndex
CREATE INDEX "stacks_templateId_idx" ON "stacks"("templateId");

-- CreateIndex
CREATE INDEX "stack_services_stackId_idx" ON "stack_services"("stackId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_services_stackId_serviceName_key" ON "stack_services"("stackId", "serviceName");

-- CreateIndex
CREATE INDEX "stack_deployments_stackId_idx" ON "stack_deployments"("stackId");

-- CreateIndex
CREATE INDEX "stack_deployments_createdAt_idx" ON "stack_deployments"("createdAt");

-- CreateIndex
CREATE INDEX "stack_resources_stackId_idx" ON "stack_resources"("stackId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_resources_stackId_resourceType_resourceName_key" ON "stack_resources"("stackId", "resourceType", "resourceName");

-- CreateIndex
CREATE INDEX "infra_resources_stackId_idx" ON "infra_resources"("stackId");

-- CreateIndex
CREATE INDEX "infra_resources_environmentId_idx" ON "infra_resources"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "infra_resources_type_purpose_scope_environmentId_key" ON "infra_resources"("type", "purpose", "scope", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_templates_currentVersionId_key" ON "stack_templates"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_templates_draftVersionId_key" ON "stack_templates"("draftVersionId");

-- CreateIndex
CREATE INDEX "stack_templates_source_idx" ON "stack_templates"("source");

-- CreateIndex
CREATE INDEX "stack_templates_scope_idx" ON "stack_templates"("scope");

-- CreateIndex
CREATE INDEX "stack_templates_isArchived_idx" ON "stack_templates"("isArchived");

-- CreateIndex
CREATE INDEX "stack_templates_environmentId_idx" ON "stack_templates"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_templates_name_source_key" ON "stack_templates"("name", "source");

-- CreateIndex
CREATE INDEX "stack_template_versions_templateId_idx" ON "stack_template_versions"("templateId");

-- CreateIndex
CREATE INDEX "stack_template_versions_status_idx" ON "stack_template_versions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "stack_template_versions_templateId_version_key" ON "stack_template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "stack_template_services_versionId_idx" ON "stack_template_services"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_template_services_versionId_serviceName_key" ON "stack_template_services"("versionId", "serviceName");

-- CreateIndex
CREATE INDEX "stack_template_config_files_versionId_idx" ON "stack_template_config_files"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_template_config_files_versionId_serviceName_volumeName_mountPath_key" ON "stack_template_config_files"("versionId", "serviceName", "volumeName", "mountPath");

-- CreateIndex
CREATE UNIQUE INDEX "dns_cache_zones_cloudflareZoneId_key" ON "dns_cache_zones"("cloudflareZoneId");

-- CreateIndex
CREATE INDEX "dns_cache_zones_name_idx" ON "dns_cache_zones"("name");

-- CreateIndex
CREATE UNIQUE INDEX "dns_cache_records_cloudflareRecordId_key" ON "dns_cache_records"("cloudflareRecordId");

-- CreateIndex
CREATE INDEX "dns_cache_records_zoneId_idx" ON "dns_cache_records"("zoneId");

-- CreateIndex
CREATE INDEX "dns_cache_records_name_idx" ON "dns_cache_records"("name");

-- CreateIndex
CREATE INDEX "dns_cache_records_type_idx" ON "dns_cache_records"("type");

