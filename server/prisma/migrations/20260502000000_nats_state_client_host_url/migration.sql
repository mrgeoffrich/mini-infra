-- Add a host-loopback NATS URL alongside the docker-DNS clientUrl. Used by
-- services running in `network_mode: host` (egress-fw-agent, ALT-27) where
-- `nats://mini-infra-vault-nats-nats:4222` doesn't resolve. Populated by
-- `applyConfig()` from the vault-nats stack's `nats-host-port` parameter.
--
-- Nullable: existing rows have no host URL yet, and the field stays NULL
-- until the vault-nats stack is applied at least once after this migration.
ALTER TABLE "nats_state" ADD COLUMN "clientHostUrl" TEXT;
