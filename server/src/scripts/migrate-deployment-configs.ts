#!/usr/bin/env tsx

import prisma from "../lib/prisma";
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

async function migrateDeploymentConfigs() {
  logger.info("Starting deployment configuration migration to environment-based system");

  try {
    // 1. Check if any deployment configs exist without environmentId
    // Since environmentId is now required, we need to check if any configs exist at all
    // and if so, ensure they have a valid environment
    const allConfigs = await prisma.deploymentConfiguration.findMany({
      include: {
        environment: true,
      },
    });

    const configsWithoutEnvironment = allConfigs.filter(config => !config.environment);

    if (configsWithoutEnvironment.length === 0) {
      logger.info("No deployment configurations need migration");
      return;
    }

    logger.info(
      { count: configsWithoutEnvironment.length },
      "Found deployment configurations that need environment assignment"
    );

    // 2. Check if a default environment exists
    let defaultEnvironment = await prisma.environment.findFirst({
      where: {
        name: "default",
      },
    });

    // 3. Create default environment if it doesn't exist
    if (!defaultEnvironment) {
      logger.info("Creating default environment for existing deployment configurations");

      defaultEnvironment = await prisma.environment.create({
        data: {
          name: "default",
          description: "Default environment for migrated deployment configurations",
          type: "nonproduction",
          status: "running",
          isActive: true,
        },
      });

      logger.info(
        { environmentId: defaultEnvironment.id },
        "Created default environment"
      );
    } else {
      logger.info(
        { environmentId: defaultEnvironment.id },
        "Using existing default environment"
      );
    }

    // 4. Update all deployment configs without environmentId
    const configIdsToUpdate = configsWithoutEnvironment.map(config => config.id);
    const updateResult = await prisma.deploymentConfiguration.updateMany({
      where: {
        id: {
          in: configIdsToUpdate,
        },
      },
      data: {
        environmentId: defaultEnvironment.id,
      },
    });

    logger.info(
      {
        updatedCount: updateResult.count,
        environmentId: defaultEnvironment.id,
        environmentName: defaultEnvironment.name
      },
      "Successfully migrated deployment configurations to default environment"
    );

    // 5. Verify migration
    const verifyConfigs = await prisma.deploymentConfiguration.findMany({
      include: {
        environment: true,
      },
    });
    const remainingConfigs = verifyConfigs.filter(config => !config.environment).length;

    if (remainingConfigs > 0) {
      logger.error(
        { remainingCount: remainingConfigs },
        "Migration incomplete - some configs still without environment"
      );
      throw new Error("Migration failed - incomplete environment assignment");
    }

    logger.info("Deployment configuration migration completed successfully");

  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Failed to migrate deployment configurations"
    );
    throw error;
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  console.log("Starting deployment configuration migration...");
  migrateDeploymentConfigs()
    .then(() => {
      console.log("Migration script completed successfully");
      logger.info("Migration script completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration script failed:", error);
      logger.error("Migration script failed", error);
      process.exit(1);
    });
}

export default migrateDeploymentConfigs;