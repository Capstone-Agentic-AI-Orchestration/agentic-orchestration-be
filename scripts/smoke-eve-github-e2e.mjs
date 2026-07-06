import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectStatus, UserRole } from '@prisma/client';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOpenRouterError(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    return typeof message === 'string' ? message : body;
  } catch {
    return body;
  }
}

async function assertOpenRouterPreflight() {
  if (process.env.LLM_PROVIDER !== 'openrouter') return;

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured.');
  }

  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'DevFlow Eve Smoke',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: 'Return {"ok":true} as JSON.',
        },
      ],
      max_tokens: 16,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenRouter preflight failed (${response.status}): ${parseOpenRouterError(body).slice(0, 500)}`,
    );
  }
}

async function assertOpenAiPreflight() {
  if (process.env.LLM_PROVIDER !== 'openai') return;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }

  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: 'Return {"ok":true} as JSON.',
        },
      ],
      max_tokens: 16,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'eve_github_smoke_preflight',
          strict: false,
          schema: { type: 'object', additionalProperties: true },
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI preflight failed (${response.status}): ${parseOpenRouterError(body).slice(0, 500)}`,
    );
  }
}

async function assertOpenCodePreflight() {
  if (process.env.LLM_PROVIDER !== 'opencode') return;

  const apiKey = process.env.OPENCODE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENCODE_API_KEY is not configured.');
  }

  const baseUrl = process.env.OPENCODE_BASE_URL || 'https://opencode.ai/zen/go/v1';
  const model = process.env.OPENCODE_MODEL || 'deepseek-v4-flash';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: 'Return {"ok":true} as JSON.',
        },
      ],
      max_tokens: 64,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenCode preflight failed (${response.status}): ${parseOpenRouterError(body).slice(0, 500)}`,
    );
  }
}

async function assertAnthropicPreflight() {
  if (process.env.LLM_PROVIDER !== 'anthropic') return;

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured.');
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      system: 'Return exactly one valid JSON object and no prose.',
      messages: [
        {
          role: 'user',
          content: 'Return {"ok":true}.',
        },
      ],
      max_tokens: 16,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Anthropic preflight failed (${response.status}): ${parseOpenRouterError(body).slice(0, 500)}`,
    );
  }
}

async function assertGeminiPreflight() {
  if (process.env.LLM_PROVIDER !== 'gemini') return;

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai';
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: 'Return {"ok":true} as JSON.',
        },
      ],
      max_tokens: 16,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'eve_github_smoke_preflight',
          strict: false,
          schema: { type: 'object', additionalProperties: true },
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Gemini preflight failed (${response.status}): ${parseOpenRouterError(body).slice(0, 500)}`,
    );
  }
}

async function assertProviderPreflight() {
  await assertOpenRouterPreflight();
  await assertOpenAiPreflight();
  await assertOpenCodePreflight();
  await assertAnthropicPreflight();
  await assertGeminiPreflight();
}

async function selectLlmProvider() {
  const requestedProvider = process.env.LLM_PROVIDER || 'openrouter';
  const autoSelect =
    (process.env.EVE_GITHUB_SMOKE_PROVIDER_AUTO ?? process.env.LANGGRAPH_GITHUB_SMOKE_PROVIDER_AUTO) !== 'false';
  const candidates = autoSelect
    ? [...new Set([requestedProvider, 'openrouter', 'opencode', 'openai', 'anthropic', 'gemini'])]
    : [requestedProvider];
  const failures = [];

  for (const provider of candidates) {
    process.env.LLM_PROVIDER = provider;
    try {
      await assertProviderPreflight();
      console.log(`Eve GitHub E2E smoke using ${provider} provider.`);
      return provider;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${provider}: ${message}`);
    }
  }

  throw new Error(
    `No usable LLM provider passed preflight. ${failures.join(' | ')}`,
  );
}

async function waitForProjectStatus(prisma, orchestration, projectId, expectedStatuses, timeoutMs, label) {
  const startedAt = Date.now();
  let lastProject = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastProject = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, status: true, repoUrl: true, runId: true },
    });

    if (lastProject && expectedStatuses.includes(lastProject.status)) {
      return lastProject;
    }

    if (lastProject?.status === ProjectStatus.FAILED) {
      const graphStatus = await orchestration.getStatus(projectId).catch(() => null);
      const latestRun = await prisma.orchestrationRun.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: { error: true, currentNode: true },
      });
      throw new Error(
        `${label} failed at ${graphStatus?.currentNode ?? latestRun?.currentNode ?? 'unknown'}: ${graphStatus?.error ?? latestRun?.error ?? 'Project status is FAILED'}`,
      );
    }

    await sleep(1000);
  }

  throw new Error(`${label} timed out. Last status: ${lastProject?.status ?? 'missing project'}`);
}

loadEnvFile();

if ((process.env.EVE_GITHUB_SMOKE_CREATE ?? process.env.LANGGRAPH_GITHUB_SMOKE_CREATE) !== 'true') {
  console.log('Eve GitHub E2E smoke skipped: set EVE_GITHUB_SMOKE_CREATE=true to create a real repository.');
  process.exit(0);
}

process.env.AGENT_PROVIDER = 'llm';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'openrouter';

await selectLlmProvider();

const [{ NestFactory }, { AppModule }, { PrismaService }, { OrchestrationService }, { GithubService }] =
  await Promise.all([
    import('@nestjs/core'),
    import('../dist/app.module.js'),
    import('../dist/prisma/prisma.service.js'),
    import('../dist/orchestration/orchestration.service.js'),
    import('../dist/github/github.service.js'),
  ]);

const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

try {
  const prisma = app.get(PrismaService);
  const orchestration = app.get(OrchestrationService);
  const github = app.get(GithubService);
  const githubStatus = github.getDeliveryStatus();

  if (!githubStatus.available) {
    console.log(`Eve GitHub E2E smoke skipped: ${githubStatus.reason}`);
    process.exit(0);
  }

  const githubVerification = await github.verifyDeliveryAccess();
  if (!githubVerification.ok) {
    console.log(`Eve GitHub E2E smoke skipped: ${githubVerification.reason}`);
    process.exit(0);
  }

  const pm = await prisma.profile.findFirst({
    where: { role: UserRole.PM },
    orderBy: { createdAt: 'asc' },
  });
  const actorId = pm?.id;
  const suffix = Date.now().toString();
  const project = await prisma.project.create({
    data: {
      companyName: `DevFlow Eve Smoke ${suffix}`,
      brief: [
        'Build a simple landing page with smooth CSS animations.',
        'Use Next.js 16, React 19 with Tailwind CSS v4.',
        'The page must have a hero section, features grid, and animated CTA button.',
        'Include fade-in, slide-up, and scale animations triggered on scroll.',
        'Keep it clean and modern — one page, no backend, no database.',
      ].join(' '),
      stackKey: 'nextjs-nestjs-supabase',
      createdById: actorId ?? null,
      ...(actorId
        ? {
            members: {
              create: [{ userId: actorId, role: UserRole.PM }],
            },
          }
        : {}),
    },
  });

  const runId = await orchestration.startRun(
    project.id,
    project.brief,
    project.stackKey,
    project.companyName,
    actorId,
  );

  await waitForProjectStatus(
    prisma,
    orchestration,
    project.id,
    [ProjectStatus.AWAITING_GATE_1],
    Number(process.env.EVE_GITHUB_SMOKE_GATE1_TIMEOUT_MS ?? process.env.LANGGRAPH_GITHUB_SMOKE_GATE1_TIMEOUT_MS ?? 180000),
    'Gate 1',
  );

  await orchestration.resumeGate1(project.id, true, 'Smoke approved architecture contract.');

  await waitForProjectStatus(
    prisma,
    orchestration,
    project.id,
    [ProjectStatus.AWAITING_GATE_2],
    Number(process.env.EVE_GITHUB_SMOKE_GATE2_TIMEOUT_MS ?? process.env.LANGGRAPH_GITHUB_SMOKE_GATE2_TIMEOUT_MS ?? 300000),
    'Gate 2',
  );

  const gate2Status = await orchestration.getStatus(project.id);
  if (gate2Status.error) {
    console.warn(`Gate 2 validation warning (continuing): ${gate2Status.error}`);
  }

  await orchestration.resumeGate2(project.id, true, 'Smoke approved generated artifacts for GitHub delivery.');

  const deliveredProject = await waitForProjectStatus(
    prisma,
    orchestration,
    project.id,
    [ProjectStatus.DELIVERED],
    Number(process.env.EVE_GITHUB_SMOKE_DELIVERY_TIMEOUT_MS ?? process.env.LANGGRAPH_GITHUB_SMOKE_DELIVERY_TIMEOUT_MS ?? 180000),
    'GitHub delivery',
  );

  if (!deliveredProject.repoUrl) {
    throw new Error('Eve GitHub E2E smoke delivered project without repoUrl.');
  }

  const [artifactCount, latestRun] = await Promise.all([
    prisma.artifact.count({ where: { projectId: project.id } }),
    prisma.orchestrationRun.findUnique({
      where: { runId },
      select: { status: true, currentNode: true, error: true },
    }),
  ]);

  console.log('Eve GitHub E2E smoke passed.');
  console.table([
    {
      projectId: project.id,
      runId,
      status: deliveredProject.status,
      repoUrl: deliveredProject.repoUrl,
      artifacts: artifactCount,
      owner: githubStatus.owner,
      runStatus: latestRun?.status ?? 'unknown',
      currentNode: latestRun?.currentNode ?? 'unknown',
    },
  ]);
} finally {
  await app.close();
}
