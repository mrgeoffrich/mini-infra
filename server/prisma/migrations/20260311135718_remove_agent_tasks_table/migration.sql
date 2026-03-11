/*
  Warnings:

  - You are about to drop the `agent_tasks` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "agent_tasks";
PRAGMA foreign_keys=on;
