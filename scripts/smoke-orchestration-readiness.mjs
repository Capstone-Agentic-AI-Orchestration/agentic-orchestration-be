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

function summarizeLlm(result) {
  return {
    ok: result.ok,
    provider: result.provider,
    model: result.model,
    fallbackModel: result.fallbackModel ?? '',
    inputTokens: result.usage?.inputTokens ?? '',
    outputTokens: result.usage?.outputTokens ?? '',
    reason: result.reason ?? '',
  };
}

function summarizeGithub(result) {
  return {
    ok: result.ok,
    owner: result.owner ?? '',
    installationOwner: result.installationOwner ?? '',
    repositoriesVisible: result.repositoriesVisible ?? '',
    reason: result.reason ?? '',
  };
}

function summarizeEngine(status) {
  return {
    requestedEngine: status.requestedEngine ?? status.llmEngine?.requestedEngine ?? '',
    activeEngine: status.activeEngine ?? status.llmEngine?.activeEngine ?? '',
    eveServiceConfigured: status.eveServiceConfigured ?? status.llmEngine?.eveServiceConfigured ?? false,
    model: status.engineModel ?? status.llmEngine?.model ?? status.model ?? '',
    fallbackReason: status.fallbackReason ?? status.llmEngine?.fallbackReason ?? '',
  };
}

loadEnvFile();

process.env.AGENT_PROVIDER = 'llm';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'openrouter';

const [{ NestFactory }, { AppModule }, { OrchestrationService }, { GithubService }] =
  await Promise.all([
    import('@nestjs/core'),
    import('../dist/app.module.js'),
    import('../dist/orchestration/orchestration.service.js'),
    import('../dist/github/github.service.js'),
  ]);

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

try {
  const orchestration = app.get(OrchestrationService);
  const github = app.get(GithubService);

  const providerStatus = orchestration.getProviderStatus();
  const llmVerification = await orchestration.verifyLlmProviderAccess();
  const githubStatus = github.getDeliveryStatus();
  const githubVerification = githubStatus.available
    ? await github.verifyDeliveryAccess()
    : {
        ok: false,
        status: githubStatus,
        owner: githubStatus.owner,
        installationOwner: null,
        repositoriesVisible: null,
        permissions: null,
        reason: githubStatus.reason,
      };

  console.log('Eve GitHub readiness checks');
  console.table([summarizeEngine(providerStatus)]);
  console.table([summarizeLlm(llmVerification)]);
  console.table([summarizeGithub(githubVerification)]);

  if (llmVerification.ok && githubVerification.ok) {
    console.log('Eve GitHub readiness passed. Set EVE_GITHUB_SMOKE_CREATE=true and run npm run smoke:eve-github for the destructive E2E flow.');
    process.exit(0);
  }

  console.log('Eve GitHub readiness incomplete. Fix the reported provider or GitHub delivery issue before running the destructive E2E flow.');
  if (process.env.ORCHESTRATION_READINESS_STRICT === 'true') {
    process.exit(1);
  }
} finally {
  await app.close();
}
