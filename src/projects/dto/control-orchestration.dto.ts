import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import type { OrchestrationControlAction } from '../../orchestration/orchestration.service';

const CONTROL_ACTIONS: OrchestrationControlAction[] = [
  'pause',
  'resume',
  'cancel',
  'retry_node',
  'skip_node',
  'modify_params',
];

export class ControlOrchestrationDto {
  @IsIn(CONTROL_ACTIONS)
  action!: OrchestrationControlAction;

  /** Target node for retry_node / skip_node. */
  @IsOptional()
  @IsString()
  nodeId?: string;

  /** Whitelisted parameter patch for modify_params. */
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}
