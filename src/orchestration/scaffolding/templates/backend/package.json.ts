import type { TemplateContext } from '../types';

export function backendPackageJson(ctx: TemplateContext): string {
  const name = ctx.projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return JSON.stringify({
    name: `${name}-backend`,
    version: '0.1.0',
    private: true,
    scripts: {
      build: 'nest build',
      start: 'node dist/main',
      'start:dev': 'nest start --watch',
      test: 'vitest run',
      lint: 'eslint "{src,test}/**/*.ts"',
    },
    dependencies: {
      '@nestjs/common': '^10.0.0',
      '@nestjs/core': '^10.0.0',
      '@nestjs/platform-express': '^10.0.0',
      '@prisma/client': '^5.0.0',
      'reflect-metadata': '^0.2.0',
      rxjs: '^7.8.0',
    },
    devDependencies: {
      typescript: '^5.0.0',
      '@types/node': '^22.0.0',
      vitest: '^2.0.0',
    },
  }, null, 2);
}
