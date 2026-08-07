import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { MachineAuthenticatedRequest } from './runtime-machine.types';

/** The machine resolved by `RuntimeTokenGuard`. Only valid on routes that use that guard. */
export const CurrentMachine = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<MachineAuthenticatedRequest>();
    return request.machine;
  },
);
