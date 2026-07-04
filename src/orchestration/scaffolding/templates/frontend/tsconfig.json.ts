import type { TemplateContext } from '../types';

export function frontendTsconfig(ctx: TemplateContext): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      plugins: [{ name: 'next' }],
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
    exclude: ['node_modules'],
  }, null, 2);
}
