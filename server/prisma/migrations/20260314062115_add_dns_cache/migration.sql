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
