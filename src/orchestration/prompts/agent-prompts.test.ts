import { describe, expect, it } from 'vitest';
import {
  BACKEND_AGENT_SYSTEM,
  FRONTEND_AGENT_SYSTEM,
  PROMPT_VERSION,
  buildAgentSystemPrompt,
  renderDesignGuidance,
} from './agent-prompts';
import {
  getAgentSkillsForRole,
  renderAgentSkillPack,
} from './agent-skill-registry';

describe('agent prompt reliability contracts', () => {
  it('tracks the prompt version used by the reliability pass', () => {
    expect(PROMPT_VERSION).toBe('v4');
  });

  it('injects self-critique and validation feedback into the next agent attempt', () => {
    const prompt = buildAgentSystemPrompt(
      FRONTEND_AGENT_SYSTEM,
      '',
      'backend: src/orders.controller.ts',
      [
        'QUALITY ISSUES:',
        '- frontend: src/app/orders/page.tsx calls /api/invoices but backend exposes /orders.',
        'MUST FIX:',
        '- Align the frontend fetch URL with the backend route.',
      ].join('\n'),
      'BACKEND ROUTES:\n- GET /orders',
    );

    expect(prompt).toContain('CROSS-AGENT CONTRACT');
    expect(prompt).toContain('GET /orders');
    expect(prompt).toContain('Your previous attempt FAILED validation');
    expect(prompt).toContain('/api/invoices');
    expect(prompt).toContain('Align the frontend fetch URL');
  });

  it('warns code agents against scaffolded files and placeholder output', () => {
    expect(FRONTEND_AGENT_SYSTEM).toContain('DO NOT emit package.json');
    expect(FRONTEND_AGENT_SYSTEM).toContain('NO placeholders');
    expect(FRONTEND_AGENT_SYSTEM).toContain('Match backend routes and DTO names exactly');
  });

  it('renders deterministic role-scoped agent skills', () => {
    const frontendSkills = getAgentSkillsForRole('frontend');
    const backendSkills = getAgentSkillsForRole('backend');

    expect(frontendSkills.map((skill) => skill.id)).toEqual([
      'artifact-contract-obedience',
      'scoped-retry-repair',
      'frontend-api-wiring',
      'frontend-design-principles',
    ]);
    expect(backendSkills.map((skill) => skill.id)).toEqual([
      'artifact-contract-obedience',
      'scoped-retry-repair',
      'backend-nest-boundaries',
    ]);
  });

  it('injects only the active role skills when prompt options include an agent role', () => {
    const prompt = buildAgentSystemPrompt({
      basePrompt: FRONTEND_AGENT_SYSTEM,
      memoryContext: 'PROJECT CONVENTIONS:\n- Use shared UI primitives.',
      agentSkillRole: 'frontend',
    });

    expect(prompt).toContain('ACTIVE AGENT SKILLS');
    expect(prompt).toContain('frontend-api-wiring@1.0.0');
    expect(prompt).toContain('Match supplied backend routes');
    expect(prompt).not.toContain('backend-nest-boundaries');
    expect(prompt).toContain('PROJECT CONVENTIONS');
  });

  it('injects domain contracts as authoritative planning artifacts', () => {
    const prompt = buildAgentSystemPrompt({
      basePrompt: BACKEND_AGENT_SYSTEM,
      domainContracts: [
        'DOMAIN CONTRACTS (authoritative planning artifacts - generated code and docs must conform to these):',
        '--- API_CONTRACT.json (backend-api) ---',
        '{"kind":"backend-api","routes":[{"method":"GET","path":"/api/orders"}]}',
      ].join('\n'),
      agentSkillRole: 'backend',
    });

    expect(prompt).toContain('DOMAIN CONTRACTS');
    expect(prompt).toContain('API_CONTRACT.json');
    expect(prompt).toContain('/api/orders');
  });

  it('injects selected frontend design guidance into prompt options', () => {
    const prompt = buildAgentSystemPrompt({
      basePrompt: FRONTEND_AGENT_SYSTEM,
      agentSkillRole: 'frontend',
      designGuidance: {
        theme: 'black',
        productFeel: 'operational',
        layoutDensity: 'compact',
        accessibilityLevel: 'strict',
        forbiddenPatterns: ['gradient orb', 'placeholder UI'],
        notes: 'Dense project cockpit, no marketing hero.',
        designSystem: {
          presetId: 'devflow-black-ops',
          palette: 'Black canvas, graphite panels, blue actions.',
          typography: 'Compact system sans hierarchy.',
          spacing: '8px grid, dense controls.',
          layout: 'Operational cockpit with project lanes.',
          components: 'Tables, timelines, tabs, and approval panels.',
          motion: 'Subtle feedback only.',
          voice: 'Concise PM language.',
          brand: 'DevFlow operational black theme.',
          antiPatterns: ['oversized hero'],
        },
      },
    });

    expect(renderDesignGuidance(null)).toBe('');
    expect(prompt).toContain('DESIGN CONTRACT');
    expect(prompt).toContain('theme: black');
    expect(prompt).toContain('productFeel: operational');
    expect(prompt).toContain('- gradient orb');
    expect(prompt).toContain('Dense project cockpit');
    expect(prompt).toContain('DESIGN.md CONTRACT');
    expect(prompt).toContain('Preset: devflow-black-ops');
    expect(prompt).toContain('## Color');
    expect(prompt).toContain('Black canvas, graphite panels, blue actions.');
    expect(prompt).toContain('- oversized hero');
    expect(prompt).toContain('OpenDesign compatibility');
  });

  it('keeps positional prompt calls backward-compatible without implicit skills', () => {
    const prompt = buildAgentSystemPrompt(
      BACKEND_AGENT_SYSTEM,
      'PROVEN PATTERNS:\n- Keep services injectable.',
    );

    expect(prompt).toContain('PROVEN PATTERNS');
    expect(prompt).not.toContain('ACTIVE AGENT SKILLS');
  });

  it('omits the skill pack for unknown or missing roles', () => {
    expect(renderAgentSkillPack()).toBe('');
  });
});
