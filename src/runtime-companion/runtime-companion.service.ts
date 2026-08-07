import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RuntimeAdapter, RuntimeMachine } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeTokenService } from './runtime-token.service';
import {
  CompleteRegistrationDto,
  HeartbeatAdapterDto,
  HeartbeatDto,
  RegisterResourceDto,
} from './dto/runtime-companion.dto';
import {
  isDispatchableKind,
  MACHINE_ONLINE_WINDOW_MS,
  TOKEN_ROTATION_GRACE_MS,
} from './runtime-machine.types';

const PAIRING_CODE_TTL_MS = 15 * 60_000;

@Injectable()
export class RuntimeCompanionService {
  private readonly logger = new Logger(RuntimeCompanionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: RuntimeTokenService,
  ) {}

  // ---------------------------------------------------------------------------
  // Discovery (daemon side, unauthenticated)
  // ---------------------------------------------------------------------------

  /**
   * The console's own web origins, for a companion deciding who may talk to its loopback API.
   *
   * Read from `CORS_ORIGIN`, the same value the WebSocket gateway parses, so there is one answer to
   * "where does the frontend live" rather than a second list that can drift. Localhost is always
   * included because that is where the console runs during development.
   */
  webOrigins(): string[] {
    const configured = (process.env.CORS_ORIGIN ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean);

    return [...new Set(['http://localhost:3001', 'http://127.0.0.1:3001', ...configured])];
  }

  // ---------------------------------------------------------------------------
  // Pairing (browser side)
  // ---------------------------------------------------------------------------

  /**
   * Issue a short-lived pairing code for the signed-in user to carry to their terminal.
   *
   * The plaintext code is returned once and never stored, so it cannot be recovered later — if the
   * user loses it they simply generate another, which is cheaper than making codes retrievable.
   */
  async createPairingCode(ownerId: string, groupId?: string) {
    const resolvedGroupId = await this.resolveGroupId(ownerId, groupId);
    const code = this.tokens.mintPairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

    await this.prisma.runtimePairingCode.create({
      data: {
        codeHash: this.tokens.hash(this.tokens.normalizeCode(code)),
        groupId: resolvedGroupId,
        ownerId,
        expiresAt,
      },
    });

    return { code, expiresAt };
  }

  /**
   * Pick the workspace a new machine belongs to.
   *
   * An explicit id is verified against membership rather than trusted, so naming someone else's
   * workspace cannot quietly place a machine inside it.
   */
  private async resolveGroupId(ownerId: string, groupId?: string): Promise<string> {
    if (groupId) {
      const membership = await this.prisma.groupMember.findFirst({
        where: { groupId, userId: ownerId, status: 'ACTIVE' },
        select: { groupId: true },
      });
      if (!membership) {
        throw new ForbiddenException('You are not a member of that workspace');
      }
      return membership.groupId;
    }

    const membership = await this.prisma.groupMember.findFirst({
      where: { userId: ownerId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { groupId: true },
    });
    if (!membership) {
      throw new BadRequestException(
        'Join a team workspace before connecting a machine',
      );
    }
    return membership.groupId;
  }

  // ---------------------------------------------------------------------------
  // Registration (daemon side, unauthenticated)
  // ---------------------------------------------------------------------------

  /**
   * Consume a pairing code and create the machine it pairs.
   *
   * The code is claimed with a conditional `updateMany` rather than a read-then-write, so two
   * daemons racing on the same code cannot both win — the same technique `acquireLease()` uses in
   * the run dispatcher. Only the caller that flips `consumedAt` proceeds.
   */
  async completeRegistration(dto: CompleteRegistrationDto) {
    const codeHash = this.tokens.hash(this.tokens.normalizeCode(dto.code));
    const now = new Date();

    const claimed = await this.prisma.runtimePairingCode.updateMany({
      where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });

    if (claimed.count !== 1) {
      throw new UnauthorizedException('Pairing code is invalid, expired, or already used');
    }

    const pairing = await this.prisma.runtimePairingCode.findUnique({
      where: { codeHash },
    });
    if (!pairing) {
      throw new UnauthorizedException('Pairing code is invalid');
    }

    const token = this.tokens.mintMachineToken();
    const machine = await this.prisma.runtimeMachine.create({
      data: {
        groupId: pairing.groupId,
        ownerId: pairing.ownerId,
        name: dto.name.trim() || 'Unnamed machine',
        os: dto.os,
        arch: dto.arch,
        runtimeVersion: dto.runtimeVersion,
        tokenHash: this.tokens.hash(token),
        lastSeenAt: now,
      },
    });

    await this.prisma.runtimePairingCode.update({
      where: { id: pairing.id },
      data: { machineId: machine.id },
    });

    this.logger.log(`Paired machine ${machine.id} (${machine.name}) for owner ${machine.ownerId}`);

    // Shape is fixed by the shipped client: it reads machine.id, machine.name and token.
    return {
      machine: {
        id: machine.id,
        workspaceId: machine.groupId,
        name: machine.name,
      },
      token,
    };
  }

  // ---------------------------------------------------------------------------
  // Heartbeat (daemon side)
  // ---------------------------------------------------------------------------

  /**
   * Record liveness and reconcile the machine's adapters.
   *
   * This doubles as adapter registration because the response is the *only* channel through which
   * the daemon learns adapter ids — omit a kind here and that CLI can never be given work, since
   * the daemon's claim loop iterates the ids it was handed.
   */
  async heartbeat(machine: RuntimeMachine, dto: HeartbeatDto) {
    const now = new Date();

    await this.prisma.runtimeMachine.update({
      where: { id: machine.id },
      data: { lastSeenAt: now, runtimeVersion: dto.runtimeVersion },
    });

    const adapters: RuntimeAdapter[] = [];
    for (const probe of dto.adapters) {
      const status = this.deriveAdapterStatus(probe);
      adapters.push(
        await this.prisma.runtimeAdapter.upsert({
          where: { machineId_kind: { machineId: machine.id, kind: probe.kind } },
          create: {
            machineId: machine.id,
            kind: probe.kind,
            displayCommand: probe.displayCommand,
            version: probe.version ?? null,
            authenticated: probe.authenticated,
            capabilities: (probe.capabilities ?? {}) as object,
            status,
            lastSeenAt: now,
          },
          update: {
            displayCommand: probe.displayCommand,
            version: probe.version ?? null,
            authenticated: probe.authenticated,
            capabilities: (probe.capabilities ?? {}) as object,
            status,
            lastSeenAt: now,
          },
        }),
      );
    }

    return {
      acknowledgedAt: now.toISOString(),
      adapters: adapters.map((adapter) => ({
        id: adapter.id,
        kind: adapter.kind,
        status: adapter.status,
        enabled: adapter.enabled,
      })),
    };
  }

  /**
   * Reconstruct the status the daemon computed but did not send.
   *
   * It reports only `version` and `authenticated`, having stripped `status` and the executable
   * path. A missing version means the CLI could not be run at all; a version without auth means
   * it is installed but nobody has signed in, which is the case worth surfacing in the UI.
   */
  private deriveAdapterStatus(probe: HeartbeatAdapterDto): string {
    if (!probe.version) return 'MISSING';
    return probe.authenticated ? 'AVAILABLE' : 'UNAUTHENTICATED';
  }

  // ---------------------------------------------------------------------------
  // Resources (daemon side)
  // ---------------------------------------------------------------------------

  /**
   * Record an opaque handle to a project directory on the machine.
   *
   * Upserted on `(machine, opaqueId)` because `resource add` is idempotent from the user's side and
   * re-running it after a fingerprint change should update the row, not accumulate duplicates.
   */
  async registerResource(machine: RuntimeMachine, dto: RegisterResourceDto) {
    const resource = await this.prisma.runtimeResource.upsert({
      where: { machineId_opaqueId: { machineId: machine.id, opaqueId: dto.opaqueId } },
      create: {
        machineId: machine.id,
        opaqueId: dto.opaqueId,
        name: dto.name,
        fingerprint: dto.fingerprint,
        access: dto.capabilities.access,
        capabilities: dto.capabilities as unknown as object,
      },
      update: {
        name: dto.name,
        fingerprint: dto.fingerprint,
        access: dto.capabilities.access,
        capabilities: dto.capabilities as unknown as object,
      },
    });

    return { id: resource.id, opaqueId: resource.opaqueId };
  }

  // ---------------------------------------------------------------------------
  // Token rotation (daemon side)
  // ---------------------------------------------------------------------------

  /**
   * Issue a new machine token, keeping the old one briefly valid.
   *
   * The grace window is not politeness: a daemon that is already running holds the old token in
   * memory and in its open socket, and `token rotate` is a separate CLI invocation it never hears
   * about. Without the overlap, rotating would silently break a working machine.
   */
  async rotateToken(machine: RuntimeMachine) {
    const token = this.tokens.mintMachineToken();

    const updated = await this.prisma.runtimeMachine.update({
      where: { id: machine.id },
      data: {
        tokenHash: this.tokens.hash(token),
        tokenVersion: { increment: 1 },
        previousTokenHash: machine.tokenHash,
        previousTokenExpiresAt: new Date(Date.now() + TOKEN_ROTATION_GRACE_MS),
      },
    });

    return { machineId: updated.id, token, tokenVersion: updated.tokenVersion };
  }

  // ---------------------------------------------------------------------------
  // Machine listing (browser side)
  // ---------------------------------------------------------------------------

  /** The caller's own machines, with liveness derived from `lastSeenAt` at read time. */
  async listMachines(ownerId: string) {
    const machines = await this.prisma.runtimeMachine.findMany({
      where: { ownerId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
      include: {
        adapters: { orderBy: { kind: 'asc' } },
        resources: { orderBy: { name: 'asc' } },
      },
    });

    const threshold = Date.now() - MACHINE_ONLINE_WINDOW_MS;

    return machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      os: machine.os,
      arch: machine.arch,
      runtimeVersion: machine.runtimeVersion,
      online: Boolean(machine.lastSeenAt && machine.lastSeenAt.getTime() > threshold),
      lastSeenAt: machine.lastSeenAt,
      createdAt: machine.createdAt,
      adapters: machine.adapters.map((adapter) => ({
        id: adapter.id,
        kind: adapter.kind,
        displayCommand: adapter.displayCommand,
        version: adapter.version,
        authenticated: adapter.authenticated,
        status: adapter.status,
        enabled: adapter.enabled,
        // Derived server-side rather than echoed from the client: whether work can be dispatched is
        // the server's decision, and the UI should not be able to promise more than it will honour.
        dispatchable: isDispatchableKind(adapter.kind),
      })),
      resources: machine.resources.map((resource) => ({
        id: resource.id,
        opaqueId: resource.opaqueId,
        name: resource.name,
        access: resource.access,
      })),
    }));
  }

  /**
   * Revoke a machine.
   *
   * Soft revocation rather than deletion, and server-side only: the CLI has no `unregister`
   * command, so this is the sole way to cut off a workstation someone no longer controls. The row
   * is kept so a revoked machine cannot be resurrected by an in-flight token still in memory.
   */
  async revokeMachine(id: string, ownerId: string): Promise<void> {
    const machine = await this.prisma.runtimeMachine.findUnique({ where: { id } });
    if (!machine || machine.revokedAt) {
      throw new NotFoundException('Machine not found');
    }
    if (machine.ownerId !== ownerId) {
      throw new ForbiddenException('You do not own this machine');
    }

    await this.prisma.runtimeMachine.update({
      where: { id },
      data: {
        revokedAt: new Date(),
        previousTokenHash: null,
        previousTokenExpiresAt: null,
      },
    });
  }

  /** Resolve a machine from a raw token. Used by the socket gateway's handshake. */
  async findMachineByToken(token: string): Promise<RuntimeMachine | null> {
    const tokenHash = this.tokens.hash(token);
    return this.prisma.runtimeMachine.findFirst({
      where: {
        revokedAt: null,
        OR: [
          { tokenHash },
          { previousTokenHash: tokenHash, previousTokenExpiresAt: { gt: new Date() } },
        ],
      },
    });
  }
}
