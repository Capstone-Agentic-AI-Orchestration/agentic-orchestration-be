import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(path = resolve(process.cwd(), '.env')) {
  let content = '';

  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}

loadEnvFile();

const [{ NestFactory }, { AppModule }, { GithubService }] = await Promise.all([
  import('@nestjs/core'),
  import('../dist/app.module.js'),
  import('../dist/github/github.service.js'),
]);

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

try {
  const github = app.get(GithubService);
  const status = github.getDeliveryStatus();
  if (!status.available) {
    console.log(`GitHub delivery smoke skipped: ${status.reason}`);
    process.exit(0);
  }

  console.table([
    {
      configured: status.configured,
      owner: status.owner,
      ownerSource: status.ownerSource,
    },
  ]);

  const verification = await github.verifyDeliveryAccess();
  if (!verification.ok) {
    console.log(`GitHub delivery smoke skipped: ${verification.reason}`);
    process.exit(0);
  }

  console.table([
    {
      owner: verification.owner,
      installationOwner: verification.installationOwner,
      repositoriesVisible: verification.repositoriesVisible,
    },
  ]);

  if (process.env.GITHUB_SMOKE_CREATE !== 'true') {
    console.log('GitHub delivery smoke verified credentials. Set GITHUB_SMOKE_CREATE=true to create a real smoke repository.');
    process.exit(0);
  }

  const repoName = github.buildRepoName('DevFlow GitHub Smoke', Date.now().toString());
  const repoUrl = await github.createRepo(repoName);
  await github.commitFiles(
    repoName,
    [
      {
        filePath: 'README.md',
        content: `# DevFlow GitHub Smoke\n\nCreated by npm run smoke:github.\n`,
      },
      {
        filePath: 'src/index.ts',
        content: `export const smoke = ${JSON.stringify(repoName)};\n`,
      },
    ],
    'test: add DevFlow GitHub smoke artifacts',
  );
  await github.injectCiWorkflow(repoName);

  console.log('GitHub delivery smoke passed.');
  console.table([
    {
      repoName,
      repoUrl,
      owner: status.owner,
    },
  ]);
} finally {
  await app.close();
}
