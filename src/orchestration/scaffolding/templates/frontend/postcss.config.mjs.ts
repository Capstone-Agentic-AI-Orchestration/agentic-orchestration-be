export function frontendPostcssConfig(): string {
  return [
    "const config = { plugins: { '@tailwindcss/postcss': {} } };",
    '',
    'export default config;',
    '',
  ].join('\n');
}
