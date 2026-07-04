export function frontendNextConfig(): string {
  return [
    "import type { NextConfig } from 'next';",
    '',
    'const nextConfig: NextConfig = {};',
    '',
    'export default nextConfig;',
    '',
  ].join('\n');
}
