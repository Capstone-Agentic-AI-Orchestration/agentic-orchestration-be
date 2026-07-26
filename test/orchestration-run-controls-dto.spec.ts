import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { StartOrchestrationDto } from '../src/projects/dto/start-orchestration.dto';

describe('StartOrchestrationDto run controls', () => {
  it('accepts a bounded token ceiling and retry count', async () => {
    const dto = plainToInstance(StartOrchestrationDto, {
      runControls: {
        tokenBudget: 200_000,
        maxRetries: 2,
      },
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects unsafe token and retry limits', async () => {
    const dto = plainToInstance(StartOrchestrationDto, {
      runControls: {
        tokenBudget: 24_999,
        maxRetries: 6,
      },
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('runControls');
    expect(errors[0]?.children?.map((child) => child.property).sort()).toEqual([
      'maxRetries',
      'tokenBudget',
    ]);
  });
});
