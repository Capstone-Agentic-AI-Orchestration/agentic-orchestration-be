import type { TemplateContext } from '../types';

export function frontendPackageJson(ctx: TemplateContext): string {
  const name = ctx.projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
    },
    dependencies: {
      next: '^16.2.6',
      react: '^19.2.6',
      'react-dom': '^19.2.6',
    },
    devDependencies: {
      typescript: '^5.8.0',
      '@types/node': '^22.0.0',
      '@types/react': '^19.2.0',
      '@types/react-dom': '^19.2.0',
      tailwindcss: '^4.2.0',
      '@tailwindcss/postcss': '^4.2.0',
    },
  }, null, 2);
}
