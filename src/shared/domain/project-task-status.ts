import { ProjectTaskStatus } from '@prisma/client';

/**
 * Statuses that mean the work is over.
 *
 * CANCELLED joined the enum with the issue board. Every "open work" count here read
 * `status !== DONE`, which would have reported abandoned work as outstanding — the exact number
 * a PM uses to decide whether a project is finished.
 */
export const CLOSED_PROJECT_TASK_STATUSES: ProjectTaskStatus[] = [
  ProjectTaskStatus.DONE,
  ProjectTaskStatus.CANCELLED,
];

export function isOpenProjectTask(status: ProjectTaskStatus): boolean {
  return !CLOSED_PROJECT_TASK_STATUSES.includes(status);
}
