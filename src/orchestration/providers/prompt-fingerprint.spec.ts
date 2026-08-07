import { describe, expect, it } from 'vitest';
import { fingerprintPrompt } from './agent-llm.router';

/**
 * Prompt fingerprints exist so a run stays explainable after its agent's instructions are
 * edited. The properties that matter are stability (the same prompt always fingerprints the
 * same) and sensitivity (any change at all produces a different hash) — a fingerprint that
 * collapsed whitespace or trimmed would quietly hide real edits.
 */
describe('fingerprintPrompt', () => {
  it('is stable for the same prompt', () => {
    const a = fingerprintPrompt('You are a frontend engineer.');
    const b = fingerprintPrompt('You are a frontend engineer.');
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when the prompt changes at all, including whitespace', () => {
    const base = fingerprintPrompt('You are a frontend engineer.');
    expect(fingerprintPrompt('You are a frontend engineer!').hash).not.toBe(base.hash);
    expect(fingerprintPrompt('You are a frontend engineer. ').hash).not.toBe(base.hash);
    expect(fingerprintPrompt('you are a frontend engineer.').hash).not.toBe(base.hash);
  });

  it('records length so prompt bloat is visible', () => {
    expect(fingerprintPrompt('abcde').chars).toBe(5);
  });

  it('returns nulls rather than hashing nothing', () => {
    for (const value of [undefined, null, '']) {
      expect(fingerprintPrompt(value)).toEqual({ hash: null, chars: null });
    }
  });

  it('distinguishes two agents whose prompts differ only by their skills', () => {
    const withoutSkill = 'Role text.';
    const withSkill = 'Role text.\n\n## Skills\n### Tailwind\nUse tokens.';
    expect(fingerprintPrompt(withSkill).hash).not.toBe(fingerprintPrompt(withoutSkill).hash);
  });
});
