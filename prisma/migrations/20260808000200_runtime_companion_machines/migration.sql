-- Companion machines: move local AI CLI detection off the API host and onto the user's own machine.
--
-- The previous local-runtime detector probed the server's own disk, so every user was shown whatever
-- happened to be installed next to the API. That question can only be answered by something running
-- on the person's workstation, which is what the `devflow-runtime` daemon does. These tables are the
-- server half of its contract.
--
-- Tokens and pairing codes are stored as SHA-256 hashes only. `previousTokenHash` exists because a
-- running daemon captures its token once at startup (in memory and in its socket handshake) and never
-- learns it was rotated — without a grace window, rotating would brick it until restart.
--
-- Liveness is intentionally not a column. The daemon heartbeats every 30s, so `lastSeenAt` is the
-- whole signal; online/offline is derived at read time. A crashed laptop never gets to say it left.

CREATE TABLE IF NOT EXISTS "orchestration"."runtime_machines" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "ownerId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "os" TEXT NOT NULL,
  "arch" TEXT NOT NULL,
  "runtimeVersion" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenVersion" INTEGER NOT NULL DEFAULT 1,
  "previousTokenHash" TEXT,
  "previousTokenExpiresAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_machines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_machines_tokenHash_key" ON "orchestration"."runtime_machines"("tokenHash");
CREATE INDEX IF NOT EXISTS "runtime_machines_ownerId_idx" ON "orchestration"."runtime_machines"("ownerId");
CREATE INDEX IF NOT EXISTS "runtime_machines_groupId_idx" ON "orchestration"."runtime_machines"("groupId");
CREATE INDEX IF NOT EXISTS "runtime_machines_lastSeenAt_idx" ON "orchestration"."runtime_machines"("lastSeenAt");

-- One row per (machine, CLI kind). The unique constraint is load-bearing: the heartbeat response is
-- the only way the daemon ever learns its adapter ids, so those ids must survive restarts.
CREATE TABLE IF NOT EXISTS "orchestration"."runtime_adapters" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "displayCommand" TEXT NOT NULL,
  "version" TEXT,
  "authenticated" BOOLEAN NOT NULL DEFAULT false,
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'MISSING',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_adapters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_adapters_machineId_kind_key" ON "orchestration"."runtime_adapters"("machineId", "kind");

-- Only the opaque id, a label and a fingerprint. The real directory path stays on the machine.
CREATE TABLE IF NOT EXISTS "orchestration"."runtime_resources" (
  "id" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "opaqueId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "access" TEXT NOT NULL,
  "capabilities" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_resources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_resources_machineId_opaqueId_key" ON "orchestration"."runtime_resources"("machineId", "opaqueId");

CREATE TABLE IF NOT EXISTS "orchestration"."runtime_pairing_codes" (
  "id" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "ownerId" UUID NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "machineId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_pairing_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "runtime_pairing_codes_codeHash_key" ON "orchestration"."runtime_pairing_codes"("codeHash");
CREATE INDEX IF NOT EXISTS "runtime_pairing_codes_ownerId_idx" ON "orchestration"."runtime_pairing_codes"("ownerId");
CREATE INDEX IF NOT EXISTS "runtime_pairing_codes_expiresAt_idx" ON "orchestration"."runtime_pairing_codes"("expiresAt");
