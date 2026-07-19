import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UserRole } from '@prisma/client';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  ORCHESTRATION_EVENT_CHANNEL,
  type OrchestrationEvent,
} from '../orchestration/streaming/protocol';

interface SubscribePayload {
  projectId: string;
}

interface StatusPayload {
  projectId: string;
  status: string;
  currentNode: string;
  error: string | null;
}

interface StateEventPayload {
  projectId: string;
  status: string;
  currentNode: string;
  nodeStatus: 'entering' | 'exiting' | 'running';
  runId: string;
  error: string | null;
  timestamp: number;
}

interface StreamChunkPayload {
  nodeId: string;
  runId: string;
  type: 'token' | 'tool-call' | 'decision' | 'error';
  chunk: string;
  metadata?: Record<string, unknown>;
}

interface StreamBatchPayload {
  projectId: string;
  nodeId: string;
  chunks: StreamChunkPayload[];
}

type AuthenticatedSocket = Socket & {
  data: Socket['data'] & {
    user?: AuthUser;
  };
};

function corsOrigins(): string | string[] {
  const configured = process.env.CORS_ORIGIN?.trim() || 'http://localhost:3001';
  const origins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length <= 1 ? origins[0] ?? 'http://localhost:3001' : origins;
}

@WebSocketGateway({
  cors: { origin: corsOrigins(), credentials: true },
  namespace: '/devflow',
})
export class DevFlowGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DevFlowGateway.name);

  constructor(
    private readonly auth: SupabaseAuthService,
    private readonly prisma: PrismaService,
  ) {}

  @WebSocketServer()
  private readonly server!: Server;

  afterInit(server: Server): void {
    server.use(async (client: AuthenticatedSocket, next) => {
      try {
        const token = this.extractBearerToken(client);
        if (!token) {
          return next(new Error('Unauthorized'));
        }
        client.data.user = await this.auth.verifyAccessToken(token);
        return next();
      } catch (error) {
        this.logger.warn(
          `Rejected socket ${client.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return next(new Error('Unauthorized'));
      }
    });
  }

  handleConnection(client: AuthenticatedSocket): void {
    this.logger.log(`Client connected: ${client.id} user=${client.data.user?.id ?? 'unknown'}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Client subscribes to status updates for a given projectId.
   * Emits `{ event: 'subscribe', data: { projectId } }` from the client side.
   * The client is joined to a Socket.IO room named after the projectId so only
   * that client (and any others monitoring the same project) receive events.
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: AuthenticatedSocket,
  ): Promise<void> {
    const { projectId } = data;
    if (!projectId) {
      this.logger.warn(`Client ${client.id} sent subscribe without projectId`);
      return;
    }
    if (!(await this.authorizeProject(client, projectId))) return;
    void client.join(projectId);
    this.logger.log(`Client ${client.id} subscribed to project ${projectId}`);
  }

  @SubscribeMessage('resync')
  async handleResync(
    @MessageBody() data: SubscribePayload & { status?: string; currentNode?: string; runId?: string },
    @ConnectedSocket() client: AuthenticatedSocket,
  ): Promise<void> {
    const { projectId, status, currentNode, runId } = data;
    if (!projectId) return;
    if (!(await this.authorizeProject(client, projectId))) return;
    void client.join(projectId);
    if (status) {
      this.emitStateSnapshot(client.id, projectId, status, currentNode ?? 'unknown', runId ?? '');
    }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: Socket,
  ): void {
    const { projectId } = data;
    if (!projectId) return;
    void client.leave(projectId);
    this.logger.log(`Client ${client.id} unsubscribed from project ${projectId}`);
  }

  /**
   * Called by OrchestrationService at each status transition.
   * Broadcasts a `project:status` event to all clients in the projectId room.
   */
  emitStatusUpdate(
    projectId: string,
    status: string,
    currentNode: string,
    error: string | null = null,
  ): void {
    const payload: StatusPayload = { projectId, status, currentNode, error };
    this.server.to(projectId).emit('project:status', payload);
    this.logger.log(
      `Emitted project:status to room ${projectId}: status=${status} node=${currentNode}`,
    );
  }

  /**
   * Emits a granular orchestration state transition event.
   * Used by OrchestrationService when nodes enter, run, or exit.
   */
  emitStateUpdate(
    projectId: string,
    status: string,
    currentNode: string,
    nodeStatus: 'entering' | 'exiting' | 'running',
    runId: string,
    error: string | null = null,
  ): void {
    const payload: StateEventPayload = {
      projectId,
      status,
      currentNode,
      nodeStatus,
      runId,
      error,
      timestamp: Date.now(),
    };
    this.server.to(projectId).emit('orchestration:state', payload);
  }

  /**
   * Phase 1 — typed protocol channel. Broadcasts a single discriminated
   * OrchestrationEvent to all clients in the projectId room on the
   * `orchestration:event` channel. The legacy `project:status` /
   * `orchestration:state` / `agent:stream` events continue to fire alongside
   * this until the frontend cutover (Phase 4).
   */
  emitEvent(projectId: string, event: OrchestrationEvent): void {
    this.server.to(projectId).emit(ORCHESTRATION_EVENT_CHANNEL, event);
  }

  /**
   * Emits batched agent stream chunks to subscribed clients.
   * Called by StreamEmitter on batch flush.
   */
  emitAgentStream(
    projectId: string,
    nodeId: string,
    chunks: StreamChunkPayload[],
  ): void {
    const payload: StreamBatchPayload = { projectId, nodeId, chunks };
    this.server.to(projectId).emit('agent:stream', payload);
  }

  /**
   * Emits the current state snapshot to a specific client (for reconnections).
   */
  emitStateSnapshot(
    clientId: string,
    projectId: string,
    status: string,
    currentNode: string,
    runId: string,
  ): void {
    const payload: StateEventPayload = {
      projectId,
      status,
      currentNode,
      nodeStatus: 'running',
      runId,
      error: null,
      timestamp: Date.now(),
    };
    this.server.to(clientId).emit('orchestration:state', payload);
  }

  private extractBearerToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const authToken = typeof auth?.token === 'string' ? auth.token : null;
    if (authToken?.trim()) return authToken.trim().replace(/^Bearer\s+/i, '');

    const header = client.handshake.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
  }

  private async authorizeProject(client: AuthenticatedSocket, projectId: string): Promise<boolean> {
    const user = client.data.user;
    if (!user) {
      client.emit('orchestration:error', { code: 'UNAUTHORIZED', message: 'Socket is not authenticated.' });
      return false;
    }

    const project = await this.prisma.project.findFirst({
      where: user.role === UserRole.ADMIN
        ? { id: projectId }
        : {
            id: projectId,
            OR: [
              { createdById: user.id },
              { members: { some: { userId: user.id } } },
            ],
          },
      select: { id: true },
    });

    if (!project) {
      client.emit('orchestration:error', { code: 'FORBIDDEN', message: 'Project is not accessible.' });
      this.logger.warn(`Client ${client.id} user=${user.id} denied access to project ${projectId}`);
      return false;
    }

    return true;
  }
}
