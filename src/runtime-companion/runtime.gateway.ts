import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RuntimeCompanionService } from './runtime-companion.service';

/** Sole event the daemon listens for. Payload is ignored — it just triggers an immediate poll. */
export const RUNTIME_TASK_AVAILABLE = 'runtime.task.available';

type MachineSocket = Socket & {
  data: Socket['data'] & { machineId?: string };
};

/**
 * Wake-up channel for companion daemons, on its own `/runtime` namespace.
 *
 * Separate from `/devflow` because that gateway authenticates with a Supabase user JWT, which a
 * headless daemon does not have — this one authenticates the same machine token used for HTTP.
 *
 * The socket is purely an optimisation. Every piece of state still travels over HTTP, and the
 * daemon falls back to a 5-second poll, so a namespace that never connects costs latency and
 * nothing else. That is why failures here are logged rather than escalated.
 */
@WebSocketGateway({
  namespace: '/runtime',
  // Deliberately permissive: the client is a Node process with no browser Origin to check, and its
  // real authentication is the handshake token verified below.
  cors: { origin: '*' },
})
export class RuntimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RuntimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(private readonly companion: RuntimeCompanionService) {}

  /**
   * Authenticate from the handshake and put the socket in a room named for its machine.
   *
   * The room has to be established here because the client emits nothing at all — no join, no
   * identify, no ack. If the server does not derive the room from the handshake token, there is no
   * later opportunity to learn who connected.
   */
  async handleConnection(client: MachineSocket): Promise<void> {
    const token = client.handshake.auth?.token;

    if (!token || typeof token !== 'string') {
      client.disconnect(true);
      return;
    }

    try {
      const machine = await this.companion.findMachineByToken(token);
      if (!machine) {
        client.disconnect(true);
        return;
      }

      client.data.machineId = machine.id;
      await client.join(machine.id);
      this.logger.log(`Machine ${machine.id} (${machine.name}) connected to wake channel`);
    } catch (error) {
      this.logger.warn(
        `Rejected runtime socket: ${error instanceof Error ? error.message : String(error)}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(client: MachineSocket): void {
    if (client.data.machineId) {
      this.logger.log(`Machine ${client.data.machineId} left the wake channel`);
    }
  }

  /**
   * Nudge one machine to check for work.
   *
   * Unused until task dispatch lands, and intentionally fire-and-forget: a machine that is asleep
   * or offline will find the work on its next poll, so a missed nudge is never a lost task.
   */
  notifyTaskAvailable(machineId: string): void {
    this.server?.to(machineId).emit(RUNTIME_TASK_AVAILABLE, {});
  }
}
