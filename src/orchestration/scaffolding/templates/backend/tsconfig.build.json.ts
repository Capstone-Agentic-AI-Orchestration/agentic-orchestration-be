export function backendTsconfigBuild(): string {
  return JSON.stringify({
    extends: './tsconfig.json',
    exclude: ['node_modules', 'test', 'dist', '**/*spec.ts'],
  }, null, 2);
}
