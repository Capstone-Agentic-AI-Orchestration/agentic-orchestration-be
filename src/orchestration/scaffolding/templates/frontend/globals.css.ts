export function frontendGlobalsCss(): string {
  return [
    '@import "tailwindcss";',
    '',
    ':root {',
    '  color-scheme: light;',
    '  font-family: Inter, ui-sans-serif, system-ui, sans-serif;',
    '}',
    '',
    '* { box-sizing: border-box; }',
    '',
    'body {',
    '  margin: 0;',
    '  background: #f8fafc;',
    '  color: #0f172a;',
    '}',
    '',
  ].join('\n');
}
