import { describe, expect, it } from 'vitest';
import { parseEveInfo } from './eve-runtime-catalog.service';

/**
 * The fixture below is the real shape returned by the deployed service, trimmed to the fields
 * the roster reads. The parser is written defensively because the installed `eve` package and
 * the deployed one are not guaranteed to be the same version — a shape change must degrade the
 * roster to "unknown" rather than throw inside a request.
 */
const DEPLOYED_INFO = {
  agent: { name: 'agentic-orchestration-ag' },
  skills: { static: [], dynamic: [] },
  subagents: {
    local: [
      {
        name: 'frontend',
        description: 'Generates production-quality React/Next.js + TypeScript frontend files from a DevFlow contract.',
        summary: { channels: 0, hooks: 0, instructions: true, schedules: 0, skills: 0, tools: 4 },
      },
      {
        name: 'self-critique',
        description: 'Reviews generated artifacts against the contract and returns quality feedback.',
        summary: { channels: 0, hooks: 0, instructions: true, schedules: 0, skills: 0, tools: 0 },
      },
    ],
  },
};

describe('parseEveInfo', () => {
  it('reads the deployed subagents from a real /eve/v1/info body', () => {
    const agents = parseEveInfo(DEPLOYED_INFO);
    expect(agents.map((a) => a.name)).toEqual(['frontend', 'self-critique']);
    expect(agents[0]).toMatchObject({ toolCount: 4, hasInstructions: true });
    expect(agents[1]).toMatchObject({ toolCount: 0, hasInstructions: true });
  });

  it('returns empty rather than throwing on shapes it does not recognise', () => {
    for (const body of [null, undefined, {}, { subagents: {} }, { subagents: { local: 'nope' } }, 42, 'x']) {
      expect(() => parseEveInfo(body)).not.toThrow();
      expect(parseEveInfo(body)).toEqual([]);
    }
  });

  it('skips entries with no usable name instead of inventing one', () => {
    const agents = parseEveInfo({
      subagents: { local: [{ description: 'nameless' }, { name: '   ' }, { name: 'qa' }] },
    });
    expect(agents.map((a) => a.name)).toEqual(['qa']);
  });

  it('defaults a missing summary to zero tools rather than undefined', () => {
    const [agent] = parseEveInfo({ subagents: { local: [{ name: 'qa' }] } });
    expect(agent).toMatchObject({ name: 'qa', toolCount: 0, hasInstructions: false, description: null });
  });
});
