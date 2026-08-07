import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RuntimeTokenService } from './runtime-token.service';
import {
  MachineAuthenticatedRequest,
  RUNTIME_TOKEN_HEADER,
} from './runtime-machine.types';

/**
 * Authenticates the companion daemon by its machine token.
 *
 * Deliberately separate from `SupabaseAuthGuard`: the daemon is not a browser session and holds no
 * user JWT — it has one long-lived opaque token in the workstation's OS credential manager. The
 * token identifies a machine, and the machine carries the owner, so every route reached through
 * this guard is already scoped to one person without consulting a role.
 */
@Injectable()
export class RuntimeTokenGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: RuntimeTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<MachineAuthenticatedRequest>();
    const header = request.headers[RUNTIME_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;

    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new UnauthorizedException('Missing machine token');
    }

    const machine = await this.resolveMachine(token.trim());
    if (!machine) {
      throw new UnauthorizedException('Invalid machine token');
    }

    request.machine = machine;
    return true;
  }

  /**
   * Accepts the current token, or a just-rotated one inside its grace window.
   *
   * A daemon reads its token once at startup and keeps it in memory and in its live socket
   * handshake, so it has no way to notice a rotation performed by a separate CLI invocation.
   * Honouring the previous hash briefly is what stops `token rotate` from bricking a running
   * daemon until someone restarts it.
   */
  private async resolveMachine(token: string) {
    const tokenHash = this.tokens.hash(token);

    return this.prisma.runtimeMachine.findFirst({
      where: {
        revokedAt: null,
        OR: [
          { tokenHash },
          {
            previousTokenHash: tokenHash,
            previousTokenExpiresAt: { gt: new Date() },
          },
        ],
      },
    });
  }
}
