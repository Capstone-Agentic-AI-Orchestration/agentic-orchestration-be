import { forwardRef, Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { MemoryModule } from '../memory/memory.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { GatewayModule } from '../gateway/gateway.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrchestrationService } from './orchestration.service';
import { RequirementsParserNode } from './nodes/requirements-parser.node';
import { ContractNegotiatorNode } from './nodes/contract-negotiator.node';
import { FrontendAgentNode } from './nodes/frontend-agent.node';
import { BackendAgentNode } from './nodes/backend-agent.node';
import { DatabaseAgentNode } from './nodes/database-agent.node';
import { ArchitectureAgentNode } from './nodes/architecture-agent.node';
import { SelfCritiqueNode } from './nodes/self-critique.node';
import { ValidatorNode } from './nodes/validator.node';
import { GithubCommitNode } from './nodes/github-commit.node';
import { AgentProviderRegistry } from './providers/agent-provider.registry';
import { ArtifactContractValidator } from './providers/artifact-contract.validator';
import { DirectLlmProvider } from './providers/direct-llm.provider';
// Eve migration — drop-in for DirectLlmProvider.generateJson + the deterministic sequencer
// that replaced the LangGraph runtime. See docs/architecture/EVE_MIGRATION.md.
import { EveLlmProvider } from './providers/eve-llm.provider';
import { AgentLlmRouter } from './providers/agent-llm.router';
import { ProviderInvocationService } from './providers/provider-invocation.service';
import { OrchestrationSequencer } from './graph/orchestration-sequencer';
import { LlmAgentProvider } from './providers/llm-agent.provider';
import { MockAgentProvider } from './providers/mock-agent.provider';
import { StreamEmitter } from './streaming/stream-emitter.service';
import { OrchestrationEmitter } from './streaming/orchestration-emitter.service';
import { OrchestrationRunDispatcher } from './run-dispatcher.service';
import { ProjectScaffolderService } from './scaffolding/project-scaffolder.service';
import { OutputValidationService } from './output-validation/output-validation.service';

@Module({
  imports: [
    // PrismaModule is global — no import needed
    GithubModule,
    MemoryModule,
    // SupervisorModule exports EventLogService, which all agent nodes inject.
    forwardRef(() => SupervisorModule),
    // Phase 2E — import GatewayModule so DevFlowGateway can be injected
    // into OrchestrationService via @Optional().
    GatewayModule,
    NotificationsModule,
  ],
  providers: [
    OrchestrationService,
    RequirementsParserNode,
    ContractNegotiatorNode,
    FrontendAgentNode,
    BackendAgentNode,
    DatabaseAgentNode,
    ArchitectureAgentNode,
    SelfCritiqueNode,
    ValidatorNode,
    GithubCommitNode,
    AgentProviderRegistry,
    ArtifactContractValidator,
    DirectLlmProvider,
    EveLlmProvider,
    AgentLlmRouter,
    ProviderInvocationService,
    OrchestrationSequencer,
    LlmAgentProvider,
    MockAgentProvider,
    StreamEmitter,
    OrchestrationEmitter,
    OrchestrationRunDispatcher,
    ProjectScaffolderService,
    OutputValidationService,
  ],
  exports: [OrchestrationService, OrchestrationEmitter],
})
export class OrchestrationModule {}
