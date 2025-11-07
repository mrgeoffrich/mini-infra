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
CREATE TABLE "deployment_configurations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationName" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "dockerRegistry" TEXT,
    "containerConfig" JSONB NOT NULL,
    "healthCheckConfig" JSONB NOT NULL,
    "rollbackConfig" JSONB NOT NULL,
    "listeningPort" INTEGER,
    "hostname" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "environmentId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "deployment_configurations_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configurationId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "dockerImage" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentState" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "oldContainerId" TEXT,
    "newContainerId" TEXT,
    "healthCheckPassed" BOOLEAN NOT NULL DEFAULT false,
    "healthCheckLogs" JSONB,
    "errorMessage" TEXT,
    "errorDetails" JSONB,
    "deploymentTime" INTEGER,
    "downtime" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "deployments_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "deployment_configurations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "deployment_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "duration" INTEGER,
    "output" TEXT,
    "errorMessage" TEXT,
    CONSTRAINT "deployment_steps_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "deployment_containers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "containerRole" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "imageId" TEXT,
    "containerConfig" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "deployment_containers_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "deployments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "environments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "networkType" TEXT NOT NULL DEFAULT 'local',
    "status" TEXT NOT NULL DEFAULT 'uninitialized',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "environment_services" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uninitialized',
    "health" TEXT NOT NULL DEFAULT 'unknown',
    "config" JSONB NOT NULL,
    "startedAt" DATETIME,
    "stoppedAt" DATETIME,
    "lastError" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "environment_services_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "environment_networks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'bridge',
    "options" JSONB,
    "dockerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environment_networks_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "environment_volumes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'local',
    "options" JSONB,
    "dockerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "environment_volumes_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "environments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "deployment_dns_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentConfigId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "dnsProvider" TEXT NOT NULL,
    "dnsRecordId" TEXT,
    "ipAddress" TEXT,
    "zoneId" TEXT,
    "zoneName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "deployment_dns_records_deploymentConfigId_fkey" FOREIGN KEY ("deploymentConfigId") REFERENCES "deployment_configurations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "haproxy_frontends" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentConfigId" TEXT NOT NULL,
    "frontendName" TEXT NOT NULL,
    "backendName" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "bindPort" INTEGER NOT NULL DEFAULT 80,
    "bindAddress" TEXT NOT NULL DEFAULT '*',
    "useSSL" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "haproxy_frontends_deploymentConfigId_fkey" FOREIGN KEY ("deploymentConfigId") REFERENCES "deployment_configurations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
CREATE UNIQUE INDEX "deployment_configurations_applicationName_key" ON "deployment_configurations"("applicationName");

-- CreateIndex
CREATE INDEX "deployment_configurations_environmentId_idx" ON "deployment_configurations"("environmentId");

-- CreateIndex
CREATE INDEX "deployment_configurations_hostname_idx" ON "deployment_configurations"("hostname");

-- CreateIndex
CREATE INDEX "deployments_configurationId_status_idx" ON "deployments"("configurationId", "status");

-- CreateIndex
CREATE INDEX "deployments_startedAt_idx" ON "deployments"("startedAt");

-- CreateIndex
CREATE INDEX "deployment_steps_deploymentId_idx" ON "deployment_steps"("deploymentId");

-- CreateIndex
CREATE INDEX "deployment_containers_deploymentId_idx" ON "deployment_containers"("deploymentId");

-- CreateIndex
CREATE INDEX "deployment_containers_containerId_idx" ON "deployment_containers"("containerId");

-- CreateIndex
CREATE INDEX "deployment_containers_deploymentId_containerRole_idx" ON "deployment_containers"("deploymentId", "containerRole");

-- CreateIndex
CREATE UNIQUE INDEX "environments_name_key" ON "environments"("name");

-- CreateIndex
CREATE INDEX "environments_type_idx" ON "environments"("type");

-- CreateIndex
CREATE INDEX "environments_networkType_idx" ON "environments"("networkType");

-- CreateIndex
CREATE INDEX "environments_status_idx" ON "environments"("status");

-- CreateIndex
CREATE INDEX "environment_services_environmentId_idx" ON "environment_services"("environmentId");

-- CreateIndex
CREATE INDEX "environment_services_status_idx" ON "environment_services"("status");

-- CreateIndex
CREATE UNIQUE INDEX "environment_services_environmentId_serviceName_key" ON "environment_services"("environmentId", "serviceName");

-- CreateIndex
CREATE INDEX "environment_networks_environmentId_idx" ON "environment_networks"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "environment_networks_environmentId_name_key" ON "environment_networks"("environmentId", "name");

-- CreateIndex
CREATE INDEX "environment_volumes_environmentId_idx" ON "environment_volumes"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "environment_volumes_environmentId_name_key" ON "environment_volumes"("environmentId", "name");

-- CreateIndex
CREATE INDEX "deployment_dns_records_deploymentConfigId_idx" ON "deployment_dns_records"("deploymentConfigId");

-- CreateIndex
CREATE INDEX "deployment_dns_records_hostname_idx" ON "deployment_dns_records"("hostname");

-- CreateIndex
CREATE INDEX "deployment_dns_records_status_idx" ON "deployment_dns_records"("status");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_frontends_deploymentConfigId_key" ON "haproxy_frontends"("deploymentConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "haproxy_frontends_frontendName_key" ON "haproxy_frontends"("frontendName");

-- CreateIndex
CREATE INDEX "haproxy_frontends_deploymentConfigId_idx" ON "haproxy_frontends"("deploymentConfigId");

-- CreateIndex
CREATE INDEX "haproxy_frontends_frontendName_idx" ON "haproxy_frontends"("frontendName");

-- CreateIndex
CREATE INDEX "haproxy_frontends_hostname_idx" ON "haproxy_frontends"("hostname");

-- CreateIndex
CREATE INDEX "haproxy_frontends_status_idx" ON "haproxy_frontends"("status");
