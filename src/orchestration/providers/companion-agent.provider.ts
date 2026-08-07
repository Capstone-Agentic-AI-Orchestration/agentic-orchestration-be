import { Injectable, Logger } from '@nestjs/common';
import { Prisma, RuntimeTaskStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  DISPATCHABLE_ADAPTER_KINDS,
  MACHINE_ONLINE_WINDOW_MS,
} from '../../runtime-companion/runtime-machine.types';
import { agentArtifactContractFor } from './agent-contracts';
import {
  AgentProviderMode,
  GeneratedWorkOrderOutput,
  WorkOrderAgentContext,
  WorkOrderAgentProvider,
} from './agent-provider.types';

/**
 * How long to wait for a machine to finish.
 *
 * Must stay under the dispatcher's job lock (`ORCHESTRATION_JOB_LOCK_MS`, 15 minutes by default) or
 * the job would be reclaimed while the work was still legitimately running.
 */
const WAIT_TIMEOUT_MS = Number(process.env.COMPANION_WAIT_TIMEOUT_MS ?? 10 * 60_000);
const POLL_INTERVAL_MS = 2_000;

/** Prompt budget. The companion slices at 50,000 bytes, so overshooting silently truncates. */
const MAX_PROMPT_CHARS = 46_000;

/**
 * Runs work orders on the user's own machine, through an AI CLI they already have installed.
 *
 * This is the point of the companion: an agent's output comes from Claude Code or Codex signed in
 * under the person's own subscription, rather than from a metered API call. The work order stays the
 * unit of record — only the execution moves off-box.
 *
 * Deliberately a peer of the LLM provider rather than a variant of it. It shares no transport,
 * because there is no HTTP request to a model here at all: a row is queued, a laptop picks it up, and
 * the answer arrives later.
 */
@Injectable()
export class CompanionAgentProvider implements WorkOrderAgentProvider {
  readonly mode: AgentProviderMode = 'companion';
  private readonly logger = new Logger(CompanionAgentProvider.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Is there a machine that could take work right now?
   *
   * Availability is a live question, not configuration — it depends on whether someone's laptop is
   * awake. Reported honestly so the registry can explain a refusal instead of failing mid-run.
   */
  async isAvailable(): Promise<boolean> {
    return (await this.eligibleMachineCount()) > 0;
  }

  async unavailableReason(): Promise<string | null> {
    if (await this.isAvailable()) return null;
    return 'No online machine with a signed-in Claude Code or Codex CLI. Open DevFlow → Runtimes and start the companion.';
  }

  private async eligibleMachineCount(): Promise<number> {
    return this.prisma.runtimeMachine.count({
      where: {
        revokedAt: null,
        lastSeenAt: { gt: new Date(Date.now() - MACHINE_ONLINE_WINDOW_MS) },
        adapters: {
          some: {
            enabled: true,
            authenticated: true,
            status: 'AVAILABLE',
            kind: { in: [...DISPATCHABLE_ADAPTER_KINDS] },
          },
        },
      },
    });
  }

  async generateWorkOrderOutput(
    context: WorkOrderAgentContext,
  ): Promise<GeneratedWorkOrderOutput> {
    const target = await this.selectTarget(context.workOrder.id);
    const contract = agentArtifactContractFor(context.workOrder.agentType);

    const task = await this.prisma.runtimeTask.create({
      data: {
        workOrderId: context.workOrder.id,
        machineId: target.machineId,
        adapterKind: target.adapterKind,
        resourceOpaqueId: target.resourceOpaqueId,
        plan: { instructions: this.buildPrompt(context, contract) },
      },
    });

    this.logger.log(
      `Queued runtime task ${task.id} for work order ${context.workOrder.id} on machine ${target.machineId} (${target.adapterKind})`,
    );

    const finished = await this.waitForCompletion(task.id);

    if (finished.status !== RuntimeTaskStatus.SUCCEEDED) {
      throw new Error(
        `Local execution ${finished.status.toLowerCase()} on ${target.machineName}: ${finished.error ?? 'no detail reported'}`,
      );
    }

    const content = this.extractContent(finished.output ?? '');
    if (!content.trim()) {
      throw new Error(`Local execution on ${target.machineName} produced no usable output.`);
    }

    // Recorded so an artifact can be traced back to the machine that produced it — useful when the
    // same work order behaves differently on two developers' setups.
    const metadata: Record<string, unknown> = {
      executedBy: 'companion',
      machineId: target.machineId,
      machineName: target.machineName,
      adapterKind: target.adapterKind,
      runtimeTaskId: task.id,
    };
    if (finished.usage && typeof finished.usage === 'object') {
      metadata.usage = finished.usage;
    }

    return {
      // Path, name and language come from the same contract the cloud path uses, so a
      // companion-produced artifact passes the identical validator.
      filePath: `work-orders/${context.workOrder.id}/${contract.fileName}`,
      displayName: `${context.workOrder.title} output`,
      language: contract.language,
      content,
      metadata: metadata as Prisma.InputJsonObject,
    };
  }

  /**
   * Choose the machine that will run this.
   *
   * Preference goes to a machine owned by whoever started the run, so "my agents use my AI" is
   * literally true rather than approximately true. A machine must also expose a directory to work in;
   * the companion refuses any task naming a resource it does not have.
   */
  private async selectTarget(workOrderId: string): Promise<{
    machineId: string;
    machineName: string;
    adapterKind: string;
    resourceOpaqueId: string;
  }> {
    const workOrder = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { projectId: true },
    });

    const latestRun = workOrder
      ? await this.prisma.orchestrationRun.findFirst({
          where: { projectId: workOrder.projectId },
          orderBy: { createdAt: 'desc' },
          select: { actorId: true },
        })
      : null;

    const candidates = await this.prisma.runtimeMachine.findMany({
      where: {
        revokedAt: null,
        lastSeenAt: { gt: new Date(Date.now() - MACHINE_ONLINE_WINDOW_MS) },
        adapters: {
          some: {
            enabled: true,
            authenticated: true,
            status: 'AVAILABLE',
            kind: { in: [...DISPATCHABLE_ADAPTER_KINDS] },
          },
        },
        resources: { some: {} },
      },
      include: {
        adapters: {
          where: {
            enabled: true,
            authenticated: true,
            status: 'AVAILABLE',
            kind: { in: [...DISPATCHABLE_ADAPTER_KINDS] },
          },
        },
        resources: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    if (candidates.length === 0) {
      throw new Error(
        'No online machine with a signed-in Claude Code or Codex CLI and a registered project directory. Open DevFlow → Runtimes.',
      );
    }

    const preferred =
      (latestRun?.actorId && candidates.find((m) => m.ownerId === latestRun.actorId)) ||
      candidates[0]!;

    const adapter = preferred.adapters[0]!;
    const resource = preferred.resources[0]!;

    return {
      machineId: preferred.id,
      machineName: preferred.name,
      adapterKind: adapter.kind,
      resourceOpaqueId: resource.opaqueId,
    };
  }

  /** Poll the task row until it reaches a terminal state, or give up and cancel it. */
  private async waitForCompletion(taskId: string) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const task = await this.prisma.runtimeTask.findUnique({
        where: { id: taskId },
        select: { status: true, output: true, error: true, usage: true },
      });
      if (!task) throw new Error('Runtime task disappeared while waiting for local execution.');
      if (task.status !== RuntimeTaskStatus.QUEUED && task.status !== RuntimeTaskStatus.LEASED) {
        return task;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Ask the machine to stop rather than abandoning it: the companion checks this flag on its task
    // heartbeat, so the CLI actually gets killed instead of running on unattended.
    await this.prisma.runtimeTask.updateMany({
      where: { id: taskId, status: { in: [RuntimeTaskStatus.QUEUED, RuntimeTaskStatus.LEASED] } },
      data: { cancelRequested: true },
    });

    throw new Error(
      `Local execution did not finish within ${Math.round(WAIT_TIMEOUT_MS / 60_000)} minutes.`,
    );
  }

  /**
   * Assemble the brief the local CLI receives.
   *
   * The same output contract as the cloud path, because the artifact is validated identically — the
   * only difference is which machine produces it.
   */
  private buildPrompt(
    context: WorkOrderAgentContext,
    contract: ReturnType<typeof agentArtifactContractFor>,
  ): string {
    const parts = [
      'You are producing one complete, production-ready project file for DevFlow.',
      'Reply with a single strict JSON object and nothing else — no prose, no markdown fences:',
      '{"content":"<the complete file as a string>"}',
      `The file will be saved as ${contract.fileName} and must be valid ${contract.language}.`,
      `It must include ${contract.requiredSignals
        .map((signal) => signal.anyOf.map((value) => `"${value}"`).join(' or '))
        .join('; ')} — treat that as a floor, not a target.`,
      '',
      `Project: ${context.project.companyName} (stack: ${context.project.stackKey})`,
      `Brief: ${context.project.brief}`,
      '',
      `Work order: ${context.workOrder.title}`,
      context.workOrder.instructions ? `Instructions: ${context.workOrder.instructions}` : null,
      context.agentProfile?.instructions ? `\nYour role:\n${context.agentProfile.instructions}` : null,
      context.task ? `\nRelated task: ${context.task.title}\n${context.task.description ?? ''}` : null,
      context.sourceArtifact
        ? `\nBuild on this existing file (${context.sourceArtifact.filePath}):\n${context.sourceArtifact.content.slice(0, 8_000)}`
        : null,
      '',
      'Do not read credentials, browser sessions, or anything outside the working directory.',
    ].filter(Boolean);

    return parts.join('\n').slice(0, MAX_PROMPT_CHARS);
  }

  /**
   * Pull the generated file out of whatever the CLI printed.
   *
   * Coding CLIs wrap their answer in their own JSON envelope, and that envelope's shape is theirs to
   * change, so this walks the parsed structure for the innermost object carrying a string `content`
   * rather than assuming a fixed path. Raw text is the last resort: saving the output beats discarding
   * real work over a formatting mismatch.
   */
  private extractContent(raw: string): string {
    const direct = this.findContentField(this.tryParse(raw));
    if (direct) return direct;

    // Some CLIs emit one JSON object per line; scan them newest-first for the answer.
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
    for (const line of lines.reverse()) {
      const found = this.findContentField(this.tryParse(line));
      if (found) return found;
    }

    const braced = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const fromBraces = braced ? this.findContentField(this.tryParse(braced)) : null;
    return fromBraces ?? raw.trim();
  }

  private tryParse(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  /** Depth-first search for a string `content` field, so envelope nesting does not matter. */
  private findContentField(value: unknown, depth = 0): string | null {
    if (!value || typeof value !== 'object' || depth > 6) return null;

    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = this.findContentField(entry, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.content === 'string' && record.content.trim()) return record.content;

    // Claude Code and Codex both nest their answer under a result-ish key; recurse rather than
    // enumerate, so a renamed envelope field does not break extraction.
    for (const nested of Object.values(record)) {
      if (typeof nested === 'string') {
        const parsed = this.findContentField(this.tryParse(nested), depth + 1);
        if (parsed) return parsed;
        continue;
      }
      const found = this.findContentField(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }
}
