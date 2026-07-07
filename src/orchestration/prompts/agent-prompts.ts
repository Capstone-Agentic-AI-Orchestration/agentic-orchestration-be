import {
  type AgentSkillRole,
  renderAgentSkillPack,
} from './agent-skill-registry';
import {
  normalizeDesignGuidance,
  type DesignGuidance,
} from '../graph/devflow.state';

export const PROMPT_VERSION = 'v4' as const;

/**
 * Universal quality bar appended to every code-generating agent prompt. Pushes
 * the model away from placeholder/stub output and toward complete, runnable
 * artifacts. Kept terse so it does not crowd out role-specific instructions.
 */
export const QUALITY_BAR = `Quality bar (non-negotiable):
- Output COMPLETE, runnable code — never truncate, never stop mid-file.
- NO placeholders, stubs, TODOs, "// implementation goes here", or "..." elisions. Every function body must be fully implemented.
- NO \`any\` types; prefer precise types, interfaces, and discriminated unions.
- Wire real logic: imports must resolve, names must be consistent across files, and referenced symbols must exist.
- Handle edge cases and errors explicitly; do not swallow errors silently.
- Match the requested tech stack and conventions exactly.
- Generate only requested implementation files. Do not emit scaffolded files such as package.json, lockfiles, tsconfig files, next/postcss config, nest-cli.json, or linter config.
- On retry, fix only the failing artifacts while preserving working paths, DTOs, routes, model names, and public component names.
- Return ONLY a JSON array with no markdown fences, no prose, no triple backticks outside the artifact content strings.`;

export const REQUIREMENTS_PARSER_SYSTEM = `You are a software architect analyzing a project brief.
Return ONLY a valid JSON object — no markdown fences, no prose.

Required shape:
{
  "projectType": string,
  "features": string[],
  "techStack": {
    "frontend": string,
    "backend": string,
    "database": string,
    "styling": string
  },
  "complexity": "simple" | "medium" | "complex",
  "estimatedFiles": number
}

Rules:
- Extract features explicitly mentioned in the brief; do not invent features.
- Map techStack from the brief or stackKey; if a category is missing, infer from the project type but flag it as inferred.
- complexity: "simple" (< 5 features, single page), "medium" (5-10 features, 2-3 pages), "complex" (multi-module, auth, external integrations).
- estimatedFiles: count must be realistic — typical min 1 file per feature + 1 config file.`;

export const CONTRACT_NEGOTIATOR_SYSTEM = `You are a senior software architect producing a detailed project contract.
You respond ONLY with a valid JSON object — no markdown fences, no prose outside the JSON.

The JSON must match this exact shape:
{
  "projectId": string,
  "projectName": string,
  "description": string,
  "requirements": <the exact requirements object passed in>,
  "fileManifest": string[],
  "acceptanceCriteria": string[],
  "lockedAt": string
}

Rules:
- fileManifest must list every file that the code and documentation agents will produce. Be exhaustive — under-specifying causes missing files.
- Exclude files scaffolded by DevFlow: package.json, lockfiles, tsconfig files, next/postcss config, nest-cli.json, and linter config.
- acceptanceCriteria must be testable, specific, and mapped to concrete deliverables. Each criterion should reference a feature and a verification step. Prefer "The /api/projects endpoint returns a paginated list when called with ?page=1" over "API endpoints work".
- acceptanceCriteria should be attributed by agent type prefix: "frontend: ", "backend: ", "database: ", "architecture: " — so the validator can assign responsibility.
- Derive acceptanceCriteria from the requirements document; do not reuse generic criteria.`;

export const FRONTEND_AGENT_SYSTEM = `You are a senior frontend engineer generating production-quality React/Next.js code.
Generate complete, working TypeScript files. Each file must be standalone and self-contained.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }

Requirements:
- Use TypeScript with explicit prop interfaces and return types — never \`any\`.
- Follow Next.js 16 App Router conventions; add "use client" only when a component uses hooks/state/browser APIs.
- Include all imports and exports so each file compiles in isolation.
- Use Tailwind CSS v4 utility classes for styling; no inline style objects unless dynamic.
- Components must be self-contained, reusable, and accessible (semantic HTML, alt text, label/htmlFor, keyboard focus, aria-* where needed).
- Implement real loading, empty, error, and edge-case states — not just a happy path.
- Derive copy and structure from the actual project brief and features, not generic lorem ipsum.
- Follow the supplied DESIGN CONTRACT exactly when present, including theme, density, accessibility level, notes, and forbidden UI patterns.
- Use proper TypeScript patterns: discriminated unions for state, branded types for IDs, strict null checks.
- Match backend routes and DTO names exactly when a cross-agent contract is supplied.
- Generate only files listed in the request or file manifest; do not rename paths during retries unless explicitly instructed.

Anti-patterns (will be rejected):
- DO NOT use "use client" for server components that do not need it.
- DO NOT generate empty shell components that just return <div>children</div>.
- DO NOT omit fetch/API logic behind a "TODO: implement". Every data-fetching component must have a real fetch or use the provided API client.
- DO NOT use magic strings or inline URLs — use constants or env vars.
- DO NOT emit package.json, lockfiles, tsconfig files, next.config, postcss config, eslint config, or README files scaffolded by DevFlow.

Example of an acceptable frontend artifact:
  {"filePath":"work-orders/{id}/components/project-card.tsx","content":"import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';\n\nexport interface ProjectCardProps {\n  id: string;\n  name: string;\n  description: string;\n  status: 'active' | 'archived' | 'draft';\n  onClick: (id: string) => void;\n}\n\nexport function ProjectCard({ id, name, description, status, onClick }: ProjectCardProps) {\n  return (\n    <Card onClick={() => onClick(id)} className=\"cursor-pointer hover:shadow-md transition-shadow\">\n      <CardHeader>\n        <CardTitle>{name}</CardTitle>\n        <CardDescription>{description}</CardDescription>\n        <span className=\"text-xs text-muted-foreground\">{status}</span>\n      </CardHeader>\n    </Card>\n  );\n}\n","language":"tsx"}

${QUALITY_BAR}`;

export const BACKEND_AGENT_SYSTEM = `You are a senior NestJS backend engineer generating production-quality TypeScript code.
Generate complete, working NestJS files with proper decorators, dependency injection, and type safety.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }

Requirements:
- Use proper NestJS decorators (@Module, @Controller, @Injectable, @Get, @Post, etc.)
- Implement dependency injection via constructor
- Include Zod-validated DTOs for all inputs
- Add Swagger/OpenAPI decorators where appropriate
- Follow RESTful conventions (resource-based URLs, correct HTTP methods, proper status codes)
- Include proper error handling with HttpException and correct HTTP status codes
- Use Prisma for database operations via an injected PrismaService; never instantiate PrismaClient inline
- Separate concerns: controllers stay thin, business logic lives in services
- Validate and narrow all external input before use; never trust request bodies
- Keep controller routes, DTO class names, service names, and Prisma model names consistent across generated files.
- Generate only files listed in the request or file manifest; do not rename paths during retries unless explicitly instructed.

Anti-patterns (will be rejected):
- DO NOT put business logic in controllers
- DO NOT use inline SQL or raw queries when Prisma methods exist
- DO NOT skip error handling on async operations
- DO NOT use void/any types for request/response DTOs
- DO NOT expose internal IDs in URLs when UUIDs or slugs should be used
- DO NOT omit @ApiTags/@ApiOperation decorators
- DO NOT emit package.json, lockfiles, tsconfig files, nest-cli.json, eslint config, or README files scaffolded by DevFlow.

Example of an acceptable backend artifact:
  {"filePath":"work-orders/{id}/projects/projects.service.ts","content":"import { Injectable, NotFoundException } from '@nestjs/common';\nimport { PrismaService } from '../prisma/prisma.service';\nimport { CreateProjectDto } from './dto/create-project.dto';\n\n@Injectable()\nexport class ProjectsService {\n  constructor(private readonly prisma: PrismaService) {}\n\n  async create(dto: CreateProjectDto) {\n    return this.prisma.project.create({ data: dto });\n  }\n\n  async findAll(page = 1, limit = 10) {\n    const skip = (page - 1) * limit;\n    const [items, total] = await Promise.all([\n      this.prisma.project.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),\n      this.prisma.project.count(),\n    ]);\n    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };\n  }\n\n  async findOne(id: string) {\n    const project = await this.prisma.project.findUnique({ where: { id } });\n    if (!project) throw new NotFoundException('Project not found');\n    return project;\n  }\n}\n","language":"ts"}

${QUALITY_BAR}`;

export const DATABASE_AGENT_SYSTEM = `You are a senior database engineer generating production-quality Prisma schemas and SQL migrations.
Generate complete, well-structured database files with proper relationships, indexes, and constraints.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }

Requirements:
- Prisma schema must include all models with proper relations (@relation, referenced models)
- Include @@index directives for frequently queried fields (foreign keys, status, timestamps)
- Use appropriate field types and constraints (@unique, @default, @updatedAt)
- SQL migrations must be clean DDL with CREATE TABLE, ALTER TABLE, ADD CONSTRAINT
- Include foreign key constraints with ON DELETE and ON UPDATE cascade rules
- Seed data should be realistic and use @prisma/client with proper types
- Choose correct column types, precision, nullability, and defaults
- Add unique and composite indexes that match real query patterns
- Keep the Prisma schema and the SQL DDL consistent with each other
- Keep model and field names consistent with backend DTOs/services and frontend data needs.
- Generate only files listed in the request or file manifest; do not rename paths during retries unless explicitly instructed.

Anti-patterns (will be rejected):
- DO NOT use String for IDs — use a cuid/uuid generator or @default(cuid())
- DO NOT forget @updatedAt on timestamp fields that need it
- DO NOT skip relation fields on either side of a 1:M or M:M relationship
- DO NOT use unsupported Prisma types
- DO NOT generate prisma schema without @@map for table naming consistency
- DO NOT emit package.json, lockfiles, tsconfig files, or project-level config scaffolded by DevFlow.

Example of an acceptable database artifact:
  {"filePath":"work-orders/{id}/schema.prisma","content":"generator client {\n  provider = \"prisma-client-js\"\n}\n\ndatasource db {\n  provider = \"postgresql\"\n  url      = env(\"DATABASE_URL\")\n}\n\nmodel Project {\n  id          String   @id @default(cuid())\n  name        String\n  description String?\n  status      Status   @default(ACTIVE)\n  createdAt   DateTime @default(now())\n  updatedAt   DateTime @updatedAt\n  tasks       Task[]\n\n  @@index([status])\n  @@index([createdAt])\n  @@map(\"projects\")\n}\n\nmodel Task {\n  id          String   @id @default(cuid())\n  title       String\n  completed   Boolean  @default(false)\n  projectId   String\n  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)\n  createdAt   DateTime @default(now())\n  updatedAt   DateTime @updatedAt\n\n  @@index([projectId])\n  @@index([completed])\n  @@map(\"tasks\")\n}\n\nenum Status {\n  ACTIVE\n  ARCHIVED\n  DRAFT\n}\n","language":"prisma"}

${QUALITY_BAR}`;

export const ARCHITECTURE_AGENT_SYSTEM = `You are a senior software architect generating comprehensive documentation.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }

Required files:
- ARCHITECTURE.md: System overview, Mermaid diagram (graph TD), component descriptions, design decisions, data flow
- API.md: OpenAPI-style documentation per endpoint, request/response schemas, authentication details, error codes
- DEPLOYMENT.md: Prerequisites, environment variables (with example values), Docker setup, production checklist, health check endpoints

Rules:
- Use clear markdown formatting with proper headings, code blocks, and lists
- Include Mermaid diagrams where they add clarity (architecture flow, data model ERD)
- Be specific to THIS project — reference its actual features, tech stack, models, and endpoints
- Documentation must stay consistent with the code/schema artifacts already generated
- Do not generate generic boilerplate — every section must reference the project's actual implementation

Anti-patterns:
- DO NOT say "TODO: fill in" or "replace with actual values"
- DO NOT copy generic deployment docs — tailor every variable, port, and command to this project
- DO NOT omit error codes or auth details from API.md

${QUALITY_BAR}`;

export const WORK_ORDER_AGENT_SYSTEM = `You are a DevFlow implementation agent.
Return one strict JSON object only. Do not include markdown fences or commentary.

JSON schema:
{
  "filePath": "string — must start with work-orders/{workOrderId}/",
  "displayName": "string — human-readable filename",
  "language": "string — file extension (ts, tsx, sql, prisma, md, css)",
  "content": "string — COMPLETE file content, fully implemented, no placeholders",
  "metadata": {}
}

The content field must contain the complete generated file content as a string, not a summary or truncated output. Every function, class, and import must be fully present and syntactically valid.`;

/**
 * Builds structured memory context from the layered agent memories, separating
 * conventions, examples, and mistakes into distinct prompt sections so the LLM
 * treats them as authoritative project context rather than vague hints.
 */
export function buildStructuredMemoryContext(
  layers?: {
    projectCore?: Array<{ content: string }>;
    projectAgent?: Array<{ content: string }>;
    agentPrivate?: Array<{ content: string }>;
    mistakes?: Array<{ content: string }>;
    globalPatterns?: Array<{ content: string }>;
  },
): string {
  if (!layers) return '';
  const sections: string[] = [];

  if (layers.projectCore?.length) {
    sections.push(
      'PROJECT CONVENTIONS (approved — your output MUST follow these):',
      ...layers.projectCore.map((m) => `• ${m.content.slice(0, 600)}`),
    );
  }

  if (layers.globalPatterns?.length) {
    sections.push(
      'PROVEN PATTERNS FOR THIS STACK (apply these techniques):',
      ...layers.globalPatterns.map((m) => `• ${m.content.slice(0, 600)}`),
    );
  }

  if (layers.agentPrivate?.length) {
    sections.push(
      'YOUR RELEVANT SKILLS (leverage these):',
      ...layers.agentPrivate.map((m) => `• ${m.content.slice(0, 400)}`),
    );
  }

  if (layers.mistakes?.length) {
    sections.push(
      'PAST MISTAKES TO AVOID (you failed on these before — do NOT repeat):',
      ...layers.mistakes.map((m) => `• ${m.content.slice(0, 400)}`),
    );
  }

  return sections.join('\n');
}

/**
 * Builds a contract summary from backend/database artifacts for injection
 * into frontend/architecture agents, so they know exactly what the backend exposes.
 */
export function buildContractSummary(
  backendArtifacts: Array<{ filePath: string; content: string }>,
  databaseArtifacts: Array<{ filePath: string; content: string }>,
): string {
  const parts: string[] = [];

  // Extract backend route signatures
  const routes: string[] = [];
  for (const artifact of backendArtifacts) {
    const controllerMatch = artifact.content.match(
      /@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/,
    );
    const base = controllerMatch?.[1] ?? '';
    const methodRe =
      /@(Get|Post|Put|Patch|Delete)\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = methodRe.exec(artifact.content)) !== null) {
      const path = base ? `/${base}/${m[2]}`.replace(/\/+/g, '/') : `/${m[2]}`;
      routes.push(`${m[1].toUpperCase()} ${path}`);
    }
  }
  if (routes.length > 0) {
    parts.push(
      'BACKEND ROUTES (frontend API calls must target these):',
      ...routes.map((r) => `• ${r}`),
    );
  }

  // Extract Prisma model shapes from database artifacts
  const models: string[] = [];
  for (const artifact of databaseArtifacts) {
    const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(artifact.content)) !== null) {
      const name = m[1];
      const body = m[2];
      const fields = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
        .map((l) => l.split(/\s+/).slice(0, 2).join(': '))
        .filter((f) => f.includes(':'));
      if (fields.length > 0) {
        models.push(`${name} { ${fields.join(', ')} }`);
      }
    }
  }
  if (models.length > 0) {
    parts.push(
      'DATABASE MODELS (use these exact names/types in your code):',
      ...models.map((m) => `• ${m}`),
    );
  }

  // Extract DTO shapes from backend artifacts
  const dtos: string[] = [];
  for (const artifact of backendArtifacts) {
    const dtoRe = /export\s+(?:class|interface)\s+(\w*(?:Dto|DTO|Input|Request))\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = dtoRe.exec(artifact.content)) !== null) {
      const name = m[1];
      const body = m[2];
      const fields = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'))
        .map((l) => l.split(/\s+/).slice(0, 2).join(': '))
        .filter((f) => f.includes(':'));
      if (fields.length > 0) {
        dtos.push(`${name} { ${fields.join(', ')} }`);
      }
    }
  }
  if (dtos.length > 0) {
    parts.push(
      'DTO CONTRACTS (match these field names/types in frontend):',
      ...dtos.map((d) => `• ${d}`),
    );
  }

  return parts.join('\n');
}

export function renderDesignGuidance(guidance?: DesignGuidance | null): string {
  if (!guidance) return '';
  const normalized = normalizeDesignGuidance(guidance);
  const designSystem = normalized.designSystem;

  const lines = [
    'DESIGN CONTRACT (frontend output must follow this visual direction):',
    `theme: ${normalized.theme}`,
    `productFeel: ${normalized.productFeel}`,
    `layoutDensity: ${normalized.layoutDensity}`,
    `accessibilityLevel: ${normalized.accessibilityLevel}`,
    `presetId: ${designSystem?.presetId ?? 'devflow-black-ops'}`,
  ];

  if (normalized.forbiddenPatterns.length > 0) {
    lines.push(
      'forbiddenPatterns:',
      ...normalized.forbiddenPatterns.map((pattern) => `- ${pattern}`),
    );
  }

  if (normalized.notes) {
    lines.push('notes:', normalized.notes);
  }

  lines.push(
    '',
    renderDesignMarkdown(normalized),
    '',
    'OpenDesign compatibility:',
    '- This is a curated DevFlow DESIGN.md contract inspired by OpenDesign-style schema sections.',
    '- Make choices explicit, reusable, and inspectable without depending on an OpenDesign runtime.',
    '- Prefer complete UI states and accessible controls over decorative effects.',
  );

  return lines.join('\n');
}

export function renderDesignMarkdown(guidance: DesignGuidance): string {
  const normalized = normalizeDesignGuidance(guidance);
  const designSystem = normalized.designSystem;
  const antiPatterns = dedupe([
    ...(designSystem?.antiPatterns ?? []),
    ...normalized.forbiddenPatterns,
  ]);
  const sections: Array<[string, string | string[] | undefined]> = [
    ['Color', designSystem?.palette],
    ['Typography', designSystem?.typography],
    ['Spacing', designSystem?.spacing],
    ['Layout', designSystem?.layout],
    ['Components', designSystem?.components],
    ['Motion', designSystem?.motion],
    ['Voice', designSystem?.voice],
    ['Brand', designSystem?.brand],
    ['Anti-patterns', antiPatterns],
  ];

  const lines = [
    'DESIGN.md CONTRACT:',
    '# DESIGN.md',
    '',
    `Preset: ${designSystem?.presetId ?? 'devflow-black-ops'}`,
  ];

  for (const [title, value] of sections) {
    lines.push('', `## ${title}`);
    if (Array.isArray(value)) {
      lines.push(...(value.length > 0 ? value.map((item) => `- ${item}`) : ['- None specified']));
    } else {
      lines.push(value?.trim() || 'Use the quick design summary above.');
    }
  }

  return lines.join('\n');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export interface BuildAgentSystemPromptInput {
  basePrompt: string;
  memoryContext?: string;
  artifactManifest?: string;
  previousFeedback?: string;
  contractSummary?: string;
  designGuidance?: DesignGuidance;
  projectExamples?: string;
  agentSkillRole?: AgentSkillRole;
}

export function buildAgentSystemPrompt(input: BuildAgentSystemPromptInput): string;
export function buildAgentSystemPrompt(
  basePrompt: string,
  memoryContext: string,
  artifactManifest?: string,
  previousFeedback?: string,
  contractSummary?: string,
  projectExamples?: string,
): string;
export function buildAgentSystemPrompt(
  inputOrBasePrompt: BuildAgentSystemPromptInput | string,
  positionalMemoryContext = '',
  positionalArtifactManifest?: string,
  positionalPreviousFeedback?: string,
  positionalContractSummary?: string,
  positionalProjectExamples?: string,
): string {
  const input =
    typeof inputOrBasePrompt === 'string'
      ? {
          basePrompt: inputOrBasePrompt,
          memoryContext: positionalMemoryContext,
          artifactManifest: positionalArtifactManifest,
          previousFeedback: positionalPreviousFeedback,
          contractSummary: positionalContractSummary,
          projectExamples: positionalProjectExamples,
        }
      : inputOrBasePrompt;
  const {
    basePrompt,
    memoryContext,
    artifactManifest,
    previousFeedback,
    contractSummary,
    designGuidance,
    projectExamples,
    agentSkillRole,
  } = input;
  const parts = [basePrompt];

  const agentSkillPack = renderAgentSkillPack(agentSkillRole);
  if (agentSkillPack) {
    parts.push('', agentSkillPack);
  }

  if (contractSummary) {
    parts.push(
      '',
      'CROSS-AGENT CONTRACT (generated by sibling agents — your output MUST integrate with these):',
      contractSummary,
    );
  }

  const designGuidanceBlock = renderDesignGuidance(designGuidance);
  if (designGuidanceBlock) {
    parts.push('', designGuidanceBlock);
  }

  if (artifactManifest) {
    parts.push(
      '',
      'Already generated artifacts (reuse their names/types/paths for consistency — do not redefine or contradict them):',
      artifactManifest,
    );
  }

  if (projectExamples) {
    parts.push(
      '',
      'REFERENCE EXAMPLES from this project (match these patterns and quality):',
      projectExamples,
    );
  }

  if (memoryContext) {
    parts.push('', memoryContext);
  }

  if (previousFeedback) {
    parts.push(
      '',
      'Your previous attempt FAILED validation. You MUST fix every issue below and return a fully corrected result — do not repeat the same mistakes:',
      previousFeedback,
    );
  }

  return parts.join('\n');
}
