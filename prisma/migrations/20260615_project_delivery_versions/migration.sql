ALTER TABLE "project_tasks"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "work_orders"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "project_tasks_id_version_idx" ON "project_tasks"("id", "version");

CREATE INDEX "work_orders_id_version_idx" ON "work_orders"("id", "version");
