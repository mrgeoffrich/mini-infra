-- AlterTable
ALTER TABLE "egress_events" ADD COLUMN "bytesDown" BIGINT;
ALTER TABLE "egress_events" ADD COLUMN "bytesUp" BIGINT;
ALTER TABLE "egress_events" ADD COLUMN "destIp" TEXT;
ALTER TABLE "egress_events" ADD COLUMN "destPort" INTEGER;
ALTER TABLE "egress_events" ADD COLUMN "method" TEXT;
ALTER TABLE "egress_events" ADD COLUMN "path" TEXT;
ALTER TABLE "egress_events" ADD COLUMN "reason" TEXT;
ALTER TABLE "egress_events" ADD COLUMN "status" INTEGER;
ALTER TABLE "egress_events" ADD COLUMN "target" TEXT;
