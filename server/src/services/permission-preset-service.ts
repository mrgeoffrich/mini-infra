import prisma from "../lib/prisma";
import { getLogger } from "../lib/logger-factory";
import { PERMISSION_PRESETS } from "@mini-infra/types";
import type {
  PermissionPresetRecord,
  PermissionScope,
  CreatePermissionPresetRequest,
  UpdatePermissionPresetRequest,
} from "@mini-infra/types";

const logger = getLogger("auth", "permission-preset-service");

function toRecord(preset: {
  id: string;
  name: string;
  description: string;
  permissions: string;
  createdAt: Date;
  updatedAt: Date;
}): PermissionPresetRecord {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    permissions: JSON.parse(preset.permissions) as PermissionScope[],
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  };
}

/**
 * Seed the 5 default permission presets if the table is empty.
 * Called once on server startup.
 */
export async function seedDefaultPresets(): Promise<void> {
  try {
    const count = await prisma.permissionPreset.count();
    if (count > 0) {
      logger.info(`Permission presets already seeded (${count} presets found)`);
      return;
    }

    logger.info("Seeding default permission presets...");
    for (const preset of PERMISSION_PRESETS) {
      await prisma.permissionPreset.upsert({
        where: { name: preset.name },
        create: {
          name: preset.name,
          description: preset.description,
          permissions: JSON.stringify(preset.permissions),
        },
        update: {},
      });
    }
    logger.info(`Seeded ${PERMISSION_PRESETS.length} default permission presets`);
  } catch (error) {
    logger.error({ error }, "Failed to seed default permission presets");
    throw error;
  }
}

export async function getAllPresets(): Promise<PermissionPresetRecord[]> {
  const presets = await prisma.permissionPreset.findMany({
    orderBy: { name: "asc" },
  });
  return presets.map(toRecord);
}

export async function createPreset(
  data: CreatePermissionPresetRequest,
): Promise<PermissionPresetRecord> {
  const preset = await prisma.permissionPreset.create({
    data: {
      name: data.name,
      description: data.description,
      permissions: JSON.stringify(data.permissions),
    },
  });
  return toRecord(preset);
}

export async function updatePreset(
  id: string,
  data: UpdatePermissionPresetRequest,
): Promise<PermissionPresetRecord> {
  const existing = await prisma.permissionPreset.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(`Permission preset not found: ${id}`);
  }

  const preset = await prisma.permissionPreset.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.permissions !== undefined && {
        permissions: JSON.stringify(data.permissions),
      }),
    },
  });
  return toRecord(preset);
}

export async function deletePreset(id: string): Promise<void> {
  const existing = await prisma.permissionPreset.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(`Permission preset not found: ${id}`);
  }
  await prisma.permissionPreset.delete({ where: { id } });
}
