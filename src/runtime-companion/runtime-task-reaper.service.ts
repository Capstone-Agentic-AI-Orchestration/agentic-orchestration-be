import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RuntimeTaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_TASK_ATTEMPTS } from './runtime-task.service';

const REAP_INTERVAL_MS = 30_000;

/**
 * Recovers tasks whose companion stopped answering.
 *
 * This is not optional housekeeping. The companion wraps its failure report in a catch that discards
 * errors, so a task whose machine crashed, slept, or lost network can leave no trace of having ended
 * — nothing else in the system would ever notice. An expiring lease plus this sweep is the only thing
 * standing between that and a work order that waits forever.
 */
@Injectable()
export class RuntimeTaskReaperService {
  private readonly logger = new Logger(RuntimeTaskReaperService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Interval(REAP_INTERVAL_MS)
  async reapExpiredLeases(): Promise<void> {
    try {
      const expired = await this.prisma.runtimeTask.findMany({
        where: {
          status: RuntimeTaskStatus.LEASED,
          leaseExpiresAt: { lt: new Date() },
        },
        select: { id: true, attempt: true, machineId: true },
        take: 50,
      });

      for (const task of expired) {
        // Requeue while attempts remain, otherwise fail outright. Retrying forever would keep handing
        // the same work to a machine that has already demonstrated it cannot finish it.
        if (task.attempt >= MAX_TASK_ATTEMPTS) {
          await this.prisma.runtimeTask.updateMany({
            where: { id: task.id, status: RuntimeTaskStatus.LEASED },
            data: {
              status: RuntimeTaskStatus.FAILED,
              error: `Local execution was abandoned after ${task.attempt} attempts. The machine stopped reporting.`,
              completedAt: new Date(),
              leaseTokenHash: null,
              leaseExpiresAt: null,
            },
          });
          this.logger.warn(`Runtime task ${task.id} failed: abandoned after ${task.attempt} attempts`);
          continue;
        }

        await this.prisma.runtimeTask.updateMany({
          where: { id: task.id, status: RuntimeTaskStatus.LEASED },
          data: {
            status: RuntimeTaskStatus.QUEUED,
            attempt: { increment: 1 },
            leaseTokenHash: null,
            leaseExpiresAt: null,
            startedAt: null,
          },
        });
        this.logger.log(`Runtime task ${task.id} lease expired; requeued as attempt ${task.attempt + 1}`);
      }
    } catch (error) {
      // A failed sweep must not kill the interval — the next tick should still run.
      this.logger.error(
        `Lease reaping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
