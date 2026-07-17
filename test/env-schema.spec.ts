import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env.schema';

const baseEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/postgres',
};

describe('validateEnv', () => {
  it('normalizes legacy orchestration env values used by deployed environments', () => {
    const env = validateEnv({
      ...baseEnv,
      ORCHESTRATION_LLM_ENGINE: 'direct',
      ORCHESTRATION_DISPATCHER_MODE: 'db-lease',
    });

    expect(env.ORCHESTRATION_LLM_ENGINE).toBe('graph');
    expect(env.ORCHESTRATION_DISPATCHER_MODE).toBe('in-process');
  });
});
