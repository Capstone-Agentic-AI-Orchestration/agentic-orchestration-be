import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkOrderAgentType, WorkOrderPriority } from '@prisma/client';

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

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  console.log('OpenRouter smoke skipped: OPENROUTER_API_KEY is not configured.');
  process.exit(0);
}

process.env.AGENT_PROVIDER = 'llm';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || 'openrouter';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash:free';
process.env.OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

const [{ LlmAgentProvider }, { ArtifactContractValidator }] = await Promise.all([
  import('../dist/orchestration/providers/llm-agent.provider.js'),
  import('../dist/orchestration/providers/artifact-contract.validator.js'),
]);

const provider = new LlmAgentProvider();
const validator = new ArtifactContractValidator();
const context = {
  project: {
    id: 'openrouter-smoke-project',
    companyName: 'OpenRouter Smoke Co',
    brief: 'Verify that OpenRouter can generate one strict DevFlow artifact JSON object.',
    stackKey: 'nextjs-nestjs-supabase',
  },
  workOrder: {
    id: 'openrouter-smoke-work-order',
    title: 'OpenRouter smoke frontend shell',
    instructions: 'Generate a tiny React component that renders a section with a div and exports the component.',
    agentType: WorkOrderAgentType.FRONTEND,
    priority: WorkOrderPriority.HIGH,
  },
  task: {
    title: 'Smoke frontend generation',
    description: 'One real-provider smoke call for strict JSON artifact generation.',
  },
  sourceArtifact: null,
  executionRunId: `openrouter-smoke-${Date.now()}`,
};

const output = await provider.generateWorkOrderOutput(context);
const validation = validator.validate(output, context);

if (!validation.valid) {
  console.error('OpenRouter smoke failed contract validation.');
  console.error(validation.errors.join('\n'));
  process.exit(1);
}

console.log('OpenRouter smoke passed.');
console.table([
  {
    provider: 'openrouter',
    model: provider.model(),
    filePath: output.filePath,
    language: output.language,
    contentChars: output.content.length,
  },
]);
