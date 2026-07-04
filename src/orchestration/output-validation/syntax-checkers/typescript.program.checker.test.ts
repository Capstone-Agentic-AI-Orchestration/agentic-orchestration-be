import { describe, it, expect } from 'vitest';
import { checkTypeScriptProgram } from './typescript.program.checker';

describe('checkTypeScriptProgram', () => {
  it('returns no errors for self-consistent files', () => {
    const result = checkTypeScriptProgram([
      {
        filePath: 'src/a.ts',
        content: `export const value = 1; export function add(n: number) { return n + value; }`,
      },
      {
        filePath: 'src/b.ts',
        content: `import { add } from './a'; export const total = add(2);`,
      },
    ]);
    expect(result.size).toBe(0);
  });

  it('flags a missing relative import (a file no agent generated)', () => {
    const result = checkTypeScriptProgram([
      {
        filePath: 'src/app.service.ts',
        content: `import { Helper } from './helper'; export class AppService { run() { return new Helper(); } }`,
      },
    ]);
    const errors = result.get('src/app.service.ts') ?? [];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe('TS_TYPE');
    expect(errors[0].message).toContain('TS2307');
  });

  it('flags an undefined identifier (cannot find name)', () => {
    const result = checkTypeScriptProgram([
      {
        filePath: 'src/x.ts',
        content: `export function run() { return doesNotExistAnywhere(); }`,
      },
    ]);
    const errors = result.get('src/x.ts') ?? [];
    expect(errors.some((e) => e.message.includes('TS2304'))).toBe(true);
  });

  it('flags a named import the generated module does not export', () => {
    const result = checkTypeScriptProgram([
      { filePath: 'src/a.ts', content: `export const realThing = 1;` },
      {
        filePath: 'src/b.ts',
        content: `import { missingThing } from './a'; export const z = missingThing;`,
      },
    ]);
    const errors = result.get('src/b.ts') ?? [];
    expect(errors.some((e) => e.message.includes('TS2305'))).toBe(true);
  });

  it('does NOT flag bare external package imports (deps are not installed)', () => {
    const result = checkTypeScriptProgram([
      {
        filePath: 'src/core.service.ts',
        content: `import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class CoreService { ping() { return 'ok'; } }`,
      },
    ]);
    expect(result.get('src/core.service.ts')).toBeUndefined();
  });

  it('does not flag JSX intrinsic elements without React types', () => {
    const result = checkTypeScriptProgram([
      {
        filePath: 'src/app/page.tsx',
        content: `export default function Page() { return <section><div>Hello</div></section>; }`,
      },
    ]);
    expect(result.get('src/app/page.tsx')).toBeUndefined();
  });

  it('returns an empty map when there are no TypeScript files', () => {
    const result = checkTypeScriptProgram([
      { filePath: 'README.md', content: '# Title' },
      { filePath: 'schema.prisma', content: 'model User { id String @id }' },
    ]);
    expect(result.size).toBe(0);
  });
});
