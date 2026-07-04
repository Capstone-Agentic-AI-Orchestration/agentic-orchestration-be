export function backendNestCli(): string {
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/nest-cli',
    collection: '@nestjs/schematics',
    sourceRoot: 'src',
  }, null, 2);
}
