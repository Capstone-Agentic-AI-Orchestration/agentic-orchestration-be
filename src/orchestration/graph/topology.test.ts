import { describe, it, expect, afterEach } from 'vitest';
import {
  NODE,
  CODE_AGENTS,
  ALL_CODE_AGENTS,
  gate1Router,
  validatorRouter,
  gate2Router,
  resolveNodeProvider,
  type FanoutTarget,
} from './topology';
import type { DevFlowStateType } from './devflow.state';

function state(overrides: Partial<DevFlowStateType> = {}): DevFlowStateType {
  return { error: null, ...overrides } as DevFlowStateType;
}

describe('topology routers', () => {
  describe('gate1Router', () => {
    it('routes to the failure node when state has an error', () => {
      expect(gate1Router(state({ error: 'boom' }))).toBe(NODE.MARK_FAILED);
    });

    it('fans out to every code agent in parallel when clear', () => {
      const result = gate1Router(state());
      expect(Array.isArray(result)).toBe(true);
      const targets = result as FanoutTarget[];
      expect(targets).toHaveLength(CODE_AGENTS.length);
      expect(targets.map((t) => t.node)).toEqual([...CODE_AGENTS]);
    });

    // Mobile is opt-in per project: dispatching it for a backend+frontend project would burn
    // tokens generating React Native code with no repository to commit it to.
    it('omits the mobile agent when the project has no mobile repository', () => {
      const targets = gate1Router(state({ hasMobileRepo: false })) as FanoutTarget[];
      expect(targets.map((t) => t.node)).not.toContain(NODE.MOBILE_AGENT);
    });

    it('includes the mobile agent when the project has a mobile repository', () => {
      const targets = gate1Router(state({ hasMobileRepo: true })) as FanoutTarget[];
      expect(targets.map((t) => t.node)).toContain(NODE.MOBILE_AGENT);
      expect(targets).toHaveLength(ALL_CODE_AGENTS.length);
    });

    it('uses the locked agent plan instead of dispatching a fixed full-stack team', () => {
      const targets = gate1Router(state({
        hasMobileRepo: false,
        contract: {
          agentPlan: {
            activeAgents: ['backend', 'qa'],
          },
        } as never,
      })) as FanoutTarget[];

      expect(targets.map((target) => target.node)).toEqual([NODE.BACKEND_AGENT]);
    });
  });

  describe('validatorRouter', () => {
    it('fans out in parallel to every agent in the retry plan, with scoped feedback', () => {
      const result = validatorRouter(
        state({
          retryPlan: [
            { agentType: 'backend', feedback: 'TYPE: missing import' },
            { agentType: 'database', feedback: 'SCHEMA: invalid model' },
          ],
        }),
      );
      expect(Array.isArray(result)).toBe(true);
      const targets = result as FanoutTarget[];
      expect(targets.map((t) => t.node)).toEqual([NODE.BACKEND_AGENT, NODE.DATABASE_AGENT]);
      // Each retried agent receives only its own feedback (carried as a state patch).
      expect(targets[0].patch?.validationFeedback).toBe('TYPE: missing import');
      expect(targets[1].patch?.validationFeedback).toBe('SCHEMA: invalid model');
    });

    it('falls back to frontend for an unknown agent type in the plan', () => {
      const result = validatorRouter(
        state({ retryPlan: [{ agentType: 'mystery' as never, feedback: 'x' }] }),
      ) as FanoutTarget[];
      expect(result[0].node).toBe(NODE.FRONTEND_AGENT);
    });

    it('proceeds to Gate 2 when the retry plan is empty or absent', () => {
      expect(validatorRouter(state({ retryPlan: [] }))).toBe(NODE.GATE_2_CHECK);
      expect(validatorRouter(state())).toBe(NODE.GATE_2_CHECK);
    });
  });

  describe('gate2Router', () => {
    it('routes any error to the failure node (retries never reach Gate 2)', () => {
      expect(gate2Router(state({ error: 'fatal' }))).toBe(NODE.MARK_FAILED);
    });

    it('commits when there is no error', () => {
      expect(gate2Router(state({ error: null }))).toBe(NODE.COMMIT_TO_GITHUB);
    });
  });
});

describe('resolveNodeProvider', () => {
  const original = process.env.NODE_PROVIDER_OVERRIDES;
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_PROVIDER_OVERRIDES;
    else process.env.NODE_PROVIDER_OVERRIDES = original;
  });

  it('returns null when no overrides are configured', () => {
    delete process.env.NODE_PROVIDER_OVERRIDES;
    expect(resolveNodeProvider(NODE.BACKEND_AGENT)).toBeNull();
  });

  it('returns the matching selector when configured', () => {
    process.env.NODE_PROVIDER_OVERRIDES = JSON.stringify({
      [NODE.BACKEND_AGENT]: { model: 'claude-opus-4-8' },
    });
    expect(resolveNodeProvider(NODE.BACKEND_AGENT)).toEqual({ model: 'claude-opus-4-8' });
    expect(resolveNodeProvider(NODE.FRONTEND_AGENT)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    process.env.NODE_PROVIDER_OVERRIDES = '{not json';
    expect(resolveNodeProvider(NODE.BACKEND_AGENT)).toBeNull();
  });
});
