import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTaskStatus, WorkOrderPriority } from '@prisma/client';
import { FrontendAgentNode } from '../src/orchestration/nodes/frontend-agent.node';
import { GithubCommitNode } from '../src/orchestration/nodes/github-commit.node';
import { RequirementsParserNode } from '../src/orchestration/nodes/requirements-parser.node';
import { GraphLlmProvider } from '../src/orchestration/providers/graph-llm.provider';
import { AgentLlmRouter } from '../src/orchestration/providers/agent-llm.router';
import { DevFlowStateType, mergeArtifactsByPath } from '../src/orchestration/graph/devflow.state';

describe('GraphLlmProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it('parses OpenRouter JSON arrays for LangGraph file agents', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_MODEL = 'test/free-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  filePath: 'src/app/page.tsx',
                  content: 'export default function Page() { return <div />; }',
                  language: 'tsx',
                },
              ]),
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 34,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'frontend_agent',
      systemPrompt: 'Generate files.',
      userPrompt: 'Generate one file.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'src/app/page.tsx', content: 'export default function Page() { return <div />; }', language: 'tsx' }],
      model: 'test/free-model',
      usage: { inputTokens: 12, outputTokens: 34 },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
  });

  it('parses OpenAI JSON arrays for LangGraph file agents', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_MODEL = 'gpt-test-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  filePath: 'ARCHITECTURE.md',
                  content: '# Architecture',
                  language: 'markdown',
                },
              ]),
            },
          },
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 22,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'architecture_agent',
      systemPrompt: 'Generate docs.',
      userPrompt: 'Generate one doc.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'ARCHITECTURE.md', content: '# Architecture', language: 'markdown' }],
      model: 'gpt-test-model',
      usage: { inputTokens: 11, outputTokens: 22 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({
        schema: expect.objectContaining({ type: 'array' }),
      }),
    }));
  });

  it('parses Gemini JSON arrays through the OpenAI-compatible path', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.GEMINI_MODEL = 'gemini-test-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  filePath: 'src/app/page.tsx',
                  content: 'export default function Page() { return <div>Gemini</div>; }',
                  language: 'tsx',
                },
              ]),
            },
          },
        ],
        usage: {
          prompt_tokens: 19,
          completion_tokens: 31,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'frontend_agent',
      systemPrompt: 'Generate files.',
      userPrompt: 'Generate one file.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'src/app/page.tsx', content: 'export default function Page() { return <div>Gemini</div>; }', language: 'tsx' }],
      model: 'gemini-test-model',
      usage: { inputTokens: 19, outputTokens: 31 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-gemini-key');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({
        schema: expect.objectContaining({ type: 'array' }),
      }),
    }));
  });

  it('parses OpenCode JSON arrays through the OpenAI-compatible path', async () => {
    process.env.LLM_PROVIDER = 'opencode';
    process.env.OPENCODE_API_KEY = 'test-opencode-key';
    process.env.OPENCODE_MODEL = 'deepseek-v4-flash';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  filePath: 'src/app/page.tsx',
                  content: 'export default function Page() { return <div>OpenCode</div>; }',
                  language: 'tsx',
                },
              ]),
            },
          },
        ],
        usage: {
          prompt_tokens: 17,
          completion_tokens: 29,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'frontend_agent',
      systemPrompt: 'Generate files.',
      userPrompt: 'Generate one file.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'src/app/page.tsx', content: 'export default function Page() { return <div>OpenCode</div>; }', language: 'tsx' }],
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 17, outputTokens: 29 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-opencode-key');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // OpenCode/DeepSeek does not support json_schema response format
    expect(body.response_format).toBeUndefined();
  });

  it('verifies the active graph LLM provider with a minimal request', async () => {
    process.env.LLM_PROVIDER = 'opencode';
    process.env.OPENCODE_API_KEY = 'test-opencode-key';
    process.env.OPENCODE_MODEL = 'deepseek-v4-flash';
    process.env.OPENCODE_FALLBACK_MODEL = 'deepseek-v4-pro';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(new GraphLlmProvider().verifyConnection()).resolves.toEqual({
      ok: true,
      provider: 'opencode',
      model: 'deepseek-v4-flash',
      fallbackModel: 'deepseek-v4-pro',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      reason: null,
      usage: { inputTokens: 4, outputTokens: 3 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });

  it('reports a missing API key during graph LLM verification without a network request', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    delete process.env.OPENROUTER_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new GraphLlmProvider().verifyConnection()).resolves.toEqual(expect.objectContaining({
      ok: false,
      provider: 'openrouter',
      reason: 'Graph LLM provider requires OPENROUTER_API_KEY.',
      usage: null,
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses Anthropic JSON arrays for LangGraph file agents', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.ANTHROPIC_MODEL = 'claude-test-model';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              {
                filePath: 'API.md',
                content: '# API',
                language: 'markdown',
              },
            ]),
          },
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 21,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'architecture_agent',
      systemPrompt: 'Generate docs.',
      userPrompt: 'Generate one doc.',
      expectedShape: 'array',
    });

    expect(result).toEqual({
      value: [{ filePath: 'API.md', content: '# API', language: 'markdown' }],
      model: 'claude-test-model',
      usage: { inputTokens: 13, outputTokens: 21 },
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.system).toContain('Generate docs.');
    expect(body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user' }),
    ]));
  });

  it('repairs malformed OpenRouter JSON before failing LangGraph agents', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '[{ bad json' } }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '[{"filePath":"ARCHITECTURE.md","content":"# Architecture","language":"markdown"}]' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GraphLlmProvider().generateJson<Array<{ filePath: string }>>({
      agentName: 'architecture_agent',
      systemPrompt: 'Generate docs.',
      userPrompt: 'Generate architecture docs.',
      expectedShape: 'array',
    });

    expect(result.value).toEqual([
      { filePath: 'ARCHITECTURE.md', content: '# Architecture', language: 'markdown' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('DevFlowState artifact reducer', () => {
  it('replaces retried artifacts by file path while preserving file order', () => {
    const result = mergeArtifactsByPath(
      [
        {
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'old frontend',
          language: 'tsx',
        },
        {
          agentType: 'backend',
          filePath: 'src/app/api/route.ts',
          content: 'backend',
          language: 'typescript',
        },
      ],
      [
        {
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'fixed frontend',
          language: 'tsx',
        },
        {
          agentType: 'architecture',
          filePath: 'README.md',
          content: '# Docs',
          language: 'markdown',
        },
      ],
    );

    expect(result.map((artifact) => artifact.filePath)).toEqual([
      'src/app/page.tsx',
      'src/app/api/route.ts',
      'README.md',
    ]);
    expect(result[0].content).toBe('fixed frontend');
  });
});

describe('LangGraph GitHub delivery node', () => {
  it('creates a plain repository, commits generated artifacts, and persists repoUrl', async () => {
    const github = {
      buildRepoName: vi.fn().mockReturnValue('acme-project-1'),
      createPlainRepository: vi.fn().mockResolvedValue({
        name: 'acme-project-1',
        fullName: 'acme/acme-project-1',
        htmlUrl: 'https://github.com/acme/project-1',
        cloneUrl: 'https://github.com/acme/project-1.git',
        defaultBranch: 'main',
        visibility: 'private',
      }),
      commitFiles: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          createdById: null,
          groupId: null,
          repoUrl: null,
          repository: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      artifact: {
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const node = new GithubCommitNode(github as never, prisma as never);

    const result = await node.execute({
      projectId: 'project-1',
      runId: 'run-1',
      companyName: 'Acme',
      artifacts: [
        {
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <div />; }',
          language: 'tsx',
        },
        {
          agentType: 'architecture',
          filePath: 'ARCHITECTURE.md',
          content: '# Architecture',
          language: 'markdown',
        },
      ],
    } as DevFlowStateType);

    expect(result).toEqual({ repoUrl: 'https://github.com/acme/project-1' });
    expect(github.createPlainRepository).toHaveBeenCalledWith(
      'acme-project-1',
      'Acme workspace created by DevFlow',
    );
    expect(github.commitFiles).toHaveBeenCalledWith(
      'acme-project-1',
      [
        {
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <div />; }',
        },
        {
          filePath: 'ARCHITECTURE.md',
          content: '# Architecture',
        },
      ],
      'feat: initial scaffold by DevFlow [run:run-1]',
    );
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { repoUrl: 'https://github.com/acme/project-1' },
    });
  });
});

describe('LangGraph OpenRouter-backed agents', () => {
  it('RequirementsParserNode uses the shared graph LLM provider', async () => {
    const graphLlm = {
      model: vi.fn().mockReturnValue('openrouter-test-model'),
      generateJson: vi.fn().mockResolvedValue({
        value: {
          projectType: 'SaaS dashboard',
          features: ['Auth', 'Tasks', 'Reports'],
          techStack: {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind CSS',
          },
          complexity: 'medium',
          estimatedFiles: 8,
        },
        model: 'openrouter-test-model',
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };
    const prisma = {
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const memory = {
      writeSkill: vi.fn().mockResolvedValue({}),
      buildContextForAgent: vi.fn().mockResolvedValue({ context: '', total: 0 }),
    };

    const mockStreamEmitter = {
      emit: vi.fn(),
      progress: vi.fn(),
      flushAll: vi.fn(),
    };

    const node = new RequirementsParserNode(
      prisma as never,
      memory as never,
      graphLlm as unknown as AgentLlmRouter,
      mockStreamEmitter as never,
    );

    const result = await node.execute({
      projectId: 'project-1',
      runId: 'run-1',
      brief: 'Build a task dashboard.',
      stackKey: 'nextjs-nestjs-supabase',
      companyName: 'Acme',
    } as DevFlowStateType);

    expect(result.requirements?.projectType).toBe('SaaS dashboard');
    expect(result.complexity).toBe('medium');
    expect(graphLlm.generateJson).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'requirements_parser',
      expectedShape: 'object',
    }));
    expect(memory.writeSkill).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'requirements',
    }));
  });

  it('FrontendAgentNode generates artifacts through the shared graph LLM provider', async () => {
    const graphLlm = {
      model: vi.fn().mockReturnValue('openrouter-test-model'),
      generateJson: vi.fn().mockResolvedValue({
        value: [
          {
            filePath: 'src/app/page.tsx',
            content: 'export default function Page() { return <section><div>App</div></section>; }',
            language: 'tsx',
          },
        ],
        model: 'openrouter-test-model',
        usage: { inputTokens: 30, outputTokens: 40 },
      }),
    };
    const memory = {
      buildContextForAgent: vi.fn().mockResolvedValue({ context: '', total: 0 }),
      findSkipCandidate: vi.fn().mockResolvedValue(null),
    };
    const prisma = {
      project: {
        update: vi.fn().mockResolvedValue({}),
      },
      artifact: {
        createMany: vi.fn().mockResolvedValue({}),
      },
    };
    const mockStreamEmitter2 = {
      emit: vi.fn(),
      progress: vi.fn(),
      flushAll: vi.fn(),
    };
    const eventLog = {
      logStarted: vi.fn().mockResolvedValue({}),
      logCompleted: vi.fn().mockResolvedValue({}),
    };

    const scaffolder = {
      scaffold: vi.fn().mockReturnValue([
        { agentType: 'frontend', filePath: 'src/app/layout.tsx', content: '', language: 'tsx' },
        { agentType: 'frontend', filePath: 'src/components/ui/Button.tsx', content: '', language: 'tsx' },
        { agentType: 'frontend', filePath: 'src/components/ui/Card.tsx', content: '', language: 'tsx' },
        { agentType: 'frontend', filePath: 'src/styles/globals.css', content: '', language: 'css' },
        { agentType: 'frontend', filePath: 'README-frontend.md', content: '', language: 'markdown' },
      ]),
      merge: vi.fn().mockImplementation((llm: { filePath: string; content: string; language: string; agentType: string }[], scaffold: { filePath: string; content: string; language: string; agentType: string }[], _type: string) => [...llm, ...scaffold]),
    };
    const outputValidation = {
      validateBatch: vi.fn().mockReturnValue([]),
    };

    const node = new FrontendAgentNode(
      prisma as never,
      memory as never,
      eventLog as never,
      graphLlm as unknown as AgentLlmRouter,
      mockStreamEmitter2 as never,
      scaffolder as never,
      outputValidation as never,
    );
    const result = await node.execute({
      projectId: 'project-1',
      runId: 'run-1',
      brief: 'Build a dashboard.',
      stackKey: 'nextjs-nestjs-supabase',
      companyName: 'Acme',
      contract: {
        projectId: 'project-1',
        projectName: 'Acme Dashboard',
        description: 'Task dashboard',
        requirements: {
          projectType: 'SaaS dashboard',
          features: ['Auth'],
          techStack: {
            frontend: 'Next.js',
            backend: 'NestJS',
            database: 'PostgreSQL',
            styling: 'Tailwind CSS',
          },
          complexity: 'simple',
          estimatedFiles: 5,
        },
        fileManifest: ['src/app/page.tsx'],
        acceptanceCriteria: ['Renders dashboard'],
        lockedAt: new Date().toISOString(),
      },
      task: {
        id: 'task-1',
        title: 'Frontend task',
        description: 'Build UI',
        status: ProjectTaskStatus.TODO,
      },
      workOrder: {
        id: 'work-order-1',
        title: 'Frontend work',
        instructions: 'Build UI',
        agentType: 'FRONTEND',
        priority: WorkOrderPriority.NORMAL,
      },
    } as unknown as DevFlowStateType);

    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentType: 'frontend',
          filePath: 'src/app/page.tsx',
          content: 'export default function Page() { return <section><div>App</div></section>; }',
          language: 'tsx',
        }),
      ]),
    );
    expect(result.artifacts?.map((artifact) => artifact.filePath)).toEqual(
      expect.arrayContaining([
        'src/app/page.tsx',
        'src/app/layout.tsx',
        'src/components/ui/Button.tsx',
        'src/components/ui/Card.tsx',
        'src/styles/globals.css',
        'README-frontend.md',
      ]),
    );
    expect(graphLlm.generateJson).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'frontend_agent',
      expectedShape: 'array',
    }));
    expect(eventLog.logCompleted).toHaveBeenCalledWith('project-1', 'frontend_agent', {
      inputTokens: 30,
      outputTokens: 40,
      model: 'openrouter-test-model',
    });
  });
});
