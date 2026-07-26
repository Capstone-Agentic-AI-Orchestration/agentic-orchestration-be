import { describe, expect, it } from 'vitest';
import { buildAgentPlan } from './agent-plan';

const requirements = {
  projectType: 'Internal tool',
  features: ['Role based access', 'Audit log'],
  techStack: {
    frontend: 'Next.js',
    backend: 'NestJS',
    database: 'PostgreSQL',
    styling: 'Tailwind CSS',
  },
  complexity: 'medium' as const,
  estimatedFiles: 8,
};

describe('buildAgentPlan', () => {
  it('selects only manifest-backed implementers and adds bounded reviewers', () => {
    const plan = buildAgentPlan({
      fileManifest: ['src/main.ts', 'src/modules/audit/audit.service.ts', 'prisma/schema.prisma'],
      requirements,
      brief: 'Build an authenticated audit API with role permissions.',
      hasMobileRepo: false,
    });

    expect(plan.activeAgents).toEqual([
      'backend',
      'database',
      'qa',
      'integration',
      'security',
    ]);
    expect(plan.activeAgents).not.toContain('frontend');
    expect(plan.activeAgents).not.toContain('mobile');
  });

  it('never activates mobile without a mobile repository', () => {
    const plan = buildAgentPlan({
      fileManifest: ['app/(tabs)/index.tsx', 'app/_layout.tsx'],
      requirements,
      hasMobileRepo: false,
    });

    expect(plan.activeAgents).not.toContain('mobile');
    expect(plan.skippedAgents).toContainEqual({
      agent: 'mobile',
      reason: 'No mobile repository is attached to this project.',
    });
  });
});
