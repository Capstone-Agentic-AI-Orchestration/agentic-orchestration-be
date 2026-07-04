import type { TemplateContext } from '../types';

export function databaseReadme(ctx: TemplateContext): string {
  return [
    '# Database',
    '',
    `This database layer was generated for ${ctx.contract.projectName}.`,
    '',
    '## Models',
    '',
    '- User stores application users.',
    '- Task stores assignable work items.',
    '',
    '## Operations',
    '',
    'Run Prisma migrations, generate the client, and execute the seed script before starting the application.',
  ].join('\n');
}
