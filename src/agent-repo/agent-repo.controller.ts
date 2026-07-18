import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { AgentRepoService } from './agent-repo.service';

interface ScopedBody {
  /** The per-turn capability token minted by the backend for this agent turn. */
  token?: string;
  /** Which repository in the project to act on: BACKEND | FRONTEND | MOBILE. */
  repository?: string;
}

interface ReadBody extends ScopedBody {
  filePath?: string;
}

interface WriteBody extends ScopedBody {
  files?: Array<{ filePath: string; content: string }>;
  message?: string;
}

/**
 * Internal callback surface for the external agent service (agentic-orchestration-ag).
 *
 * Deliberately NOT behind the normal user JWT guard: the caller is a service, not a person.
 * Authentication is the shared service secret (`AGENT_REPO_SERVICE_TOKEN`) and authorization is
 * the per-turn token, both checked on every request. These routes are not part of the public
 * API and are never called by the frontend.
 */
@Controller('internal/agent-repo')
export class AgentRepoController {
  constructor(private readonly agentRepo: AgentRepoService) {}

  @Post('list')
  @HttpCode(200)
  async list(@Headers('authorization') auth: string | undefined, @Body() body: ScopedBody) {
    this.agentRepo.assertServiceAuthorized(auth);
    const scope = await this.agentRepo.resolveScope(body.token);
    return this.agentRepo.listFiles(scope, body.repository ?? 'BACKEND');
  }

  @Post('read')
  @HttpCode(200)
  async read(@Headers('authorization') auth: string | undefined, @Body() body: ReadBody) {
    this.agentRepo.assertServiceAuthorized(auth);
    const scope = await this.agentRepo.resolveScope(body.token);
    return this.agentRepo.readFile(scope, body.repository ?? 'BACKEND', body.filePath ?? '');
  }

  @Post('write')
  @HttpCode(200)
  async write(@Headers('authorization') auth: string | undefined, @Body() body: WriteBody) {
    this.agentRepo.assertServiceAuthorized(auth);
    const scope = await this.agentRepo.resolveScope(body.token);
    return this.agentRepo.writeFiles(scope, body.repository ?? 'BACKEND', body.files ?? [], body.message);
  }
}
