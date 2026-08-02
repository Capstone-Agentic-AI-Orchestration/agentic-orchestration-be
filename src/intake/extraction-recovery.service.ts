import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DocumentExtractionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IntakeService } from './intake.service';

/** How often to look for extractions that stopped making progress. */
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * How long an extraction may sit in a non-terminal state before it is treated as abandoned.
 * Generous enough to cover OCR on a large scanned PDF, which is by far the slowest path.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Give up after this many attempts and leave the document FAILED, so a genuinely unparseable
 * file cannot be retried forever. A PM can still retry it by hand from the documents panel.
 */
const MAX_AUTOMATIC_ATTEMPTS = 3;

/**
 * Recovers document extractions that were interrupted mid-flight.
 *
 * Extraction is kicked off as unawaited background work inside the upload request, so a process
 * restart, crash, or deploy while a file is being parsed leaves its row stuck in PENDING or
 * EXTRACTING forever. That is not merely untidy: intake readiness counts a non-terminal
 * extraction as a blocker, so a single interrupted upload makes the whole intake permanently
 * un-submittable, and the only escape is a PM noticing and retrying by hand.
 */
@Injectable()
export class ExtractionRecoveryService {
  private readonly logger = new Logger(ExtractionRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intake: IntakeService,
  ) {}

  @Interval(SWEEP_INTERVAL_MS)
  async recoverStaleExtractions(): Promise<void> {
    try {
      const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
      const stale = await this.prisma.documentExtraction.findMany({
        where: {
          status: { in: [DocumentExtractionStatus.PENDING, DocumentExtractionStatus.EXTRACTING] },
          updatedAt: { lt: staleBefore },
        },
        select: { documentId: true, attempts: true },
        take: 25,
      });

      if (stale.length === 0) return;

      const exhausted = stale.filter((row) => row.attempts >= MAX_AUTOMATIC_ATTEMPTS);
      const retryable = stale.filter((row) => row.attempts < MAX_AUTOMATIC_ATTEMPTS);

      if (exhausted.length) {
        // Park these as FAILED so the UI shows an actionable error and readiness stops waiting
        // on work that is never going to complete.
        await this.prisma.documentExtraction.updateMany({
          where: { documentId: { in: exhausted.map((row) => row.documentId) } },
          data: {
            status: DocumentExtractionStatus.FAILED,
            error: `Extraction did not complete after ${MAX_AUTOMATIC_ATTEMPTS} attempts. Retry it manually or replace the file.`,
          },
        });
        this.logger.warn(`Marked ${exhausted.length} abandoned extraction(s) as failed`);
      }

      if (retryable.length) {
        this.logger.warn(`Re-queueing ${retryable.length} stale extraction(s)`);
        // Isolated so one unparseable document cannot stop the rest of the sweep.
        await Promise.allSettled(
          retryable.map((row) => this.intake.reprocessDocument(row.documentId)),
        );
      }
    } catch (error) {
      this.logger.error(
        `Extraction recovery sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
