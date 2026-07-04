import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
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

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/devflow',
})
export class DevFlowGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(DevFlowGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
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
  handleSubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: Socket,
  ): void {
    const { projectId } = data;
    if (!projectId) {
      this.logger.warn(`Client ${client.id} sent subscribe without projectId`);
      return;
    }
    void client.join(projectId);
    this.logger.log(`Client ${client.id} subscribed to project ${projectId}`);
  }

  @SubscribeMessage('resync')
  handleResync(
    @MessageBody() data: SubscribePayload & { status?: string; currentNode?: string; runId?: string },
    @ConnectedSocket() client: Socket,
  ): void {
    const { projectId, status, currentNode, runId } = data;
    if (!projectId) return;
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
}
