import { RepositoryKind } from '@prisma/client';

/**
 * Deterministic repo scaffolding — committed directly at repository creation
 * (no LLM, no tokens). Each repo kind gets a `.gitignore`, config, and a lean
 * MVVM skeleton establishing the layering the AI agents then build on. Mirrors
 * the conventions of the alphaci-be / alphaci-fe reference projects.
 */
export interface ScaffoldFile {
  filePath: string;
  content: string;
}

export interface ScaffoldContext {
  /** kebab-case project/repo slug, e.g. "acme-platform". */
  slug: string;
  companyName: string;
}

const NODE_IGNORE = `# dependencies
/node_modules
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# build
/dist
/build

# env
.env
.env.*.local
.env.local

# logs & runtime
logs
*.log
*.pid

# OS / editors
.DS_Store
Thumbs.db
.idea/
.vscode/*
!.vscode/settings.json

# tests
/coverage
/test-results

# typescript
*.tsbuildinfo
`;

function backend(ctx: ScaffoldContext): ScaffoldFile[] {
  return [
    { filePath: '.gitignore', content: NODE_IGNORE },
    {
      filePath: '.env.example',
      content: `PORT=4000\nNODE_ENV=development\nDATABASE_URL=\nSUPABASE_URL=\nSUPABASE_SERVICE_ROLE_KEY=\n`,
    },
    {
      filePath: 'package.json',
      content: JSON.stringify(
        {
          name: `${ctx.slug}-be`,
          version: '0.1.0',
          private: true,
          scripts: {
            build: 'nest build',
            start: 'node dist/main',
            'start:dev': 'nest start --watch',
            test: 'jest',
          },
          dependencies: {
            '@nestjs/common': '^10.0.0',
            '@nestjs/core': '^10.0.0',
            '@nestjs/platform-express': '^10.0.0',
            'reflect-metadata': '^0.2.0',
            rxjs: '^7.8.0',
          },
          devDependencies: {
            '@nestjs/cli': '^10.0.0',
            typescript: '^5.4.0',
            '@types/node': '^20.0.0',
          },
        },
        null,
        2,
      ),
    },
    {
      filePath: 'nest-cli.json',
      content: JSON.stringify({ collection: '@nestjs/schematics', sourceRoot: 'src' }, null, 2),
    },
    {
      filePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            module: 'commonjs',
            target: 'ES2021',
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            outDir: './dist',
            baseUrl: './',
            strict: true,
            esModuleInterop: true,
          },
        },
        null,
        2,
      ),
    },
    {
      filePath: 'README.md',
      content: `# ${ctx.companyName} — Backend\n\nNestJS API scaffolded by DevFlow.\n\n## Structure (MVVM)\n\n\`\`\`\nsrc/\n  main.ts            # bootstrap\n  app.module.ts      # root module\n  modules/<feature>/ # controller (view) -> service (view-model) -> repository (model)\n\`\`\`\n\nEach feature lives in \`src/modules/<feature>/\` with a controller, service, and repository. See \`modules/health/\` for the pattern.\n`,
    },
    {
      filePath: 'src/main.ts',
      content: `import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(process.env.PORT ?? 4000);\n}\nvoid bootstrap();\n`,
    },
    {
      filePath: 'src/app.module.ts',
      content: `import { Module } from '@nestjs/common';\nimport { HealthModule } from './modules/health/health.module';\n\n@Module({\n  imports: [HealthModule],\n})\nexport class AppModule {}\n`,
    },
    {
      filePath: 'src/modules/health/health.module.ts',
      content: `import { Module } from '@nestjs/common';\nimport { HealthController } from './health.controller';\nimport { HealthService } from './health.service';\n\n@Module({\n  controllers: [HealthController],\n  providers: [HealthService],\n})\nexport class HealthModule {}\n`,
    },
    {
      filePath: 'src/modules/health/health.controller.ts',
      content: `import { Controller, Get } from '@nestjs/common';\nimport { HealthService } from './health.service';\n\n// Controller = the "view" layer: HTTP in/out only, no business logic.\n@Controller('health')\nexport class HealthController {\n  constructor(private readonly health: HealthService) {}\n\n  @Get()\n  check() {\n    return this.health.status();\n  }\n}\n`,
    },
    {
      filePath: 'src/modules/health/health.service.ts',
      content: `import { Injectable } from '@nestjs/common';\n\n// Service = the "view-model": business logic + orchestration of repositories.\n@Injectable()\nexport class HealthService {\n  status() {\n    return { status: 'ok', ts: new Date().toISOString() };\n  }\n}\n`,
    },
  ];
}

function frontend(ctx: ScaffoldContext): ScaffoldFile[] {
  const nextIgnore = `${NODE_IGNORE}\n# next.js\n/.next/\n/out/\n.swc/\nnext-env.d.ts\n\n# vercel\n.vercel\n`;
  return [
    { filePath: '.gitignore', content: nextIgnore },
    {
      filePath: '.env.example',
      content: `NEXT_PUBLIC_API_URL=http://localhost:4000\nNEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\n`,
    },
    {
      filePath: 'package.json',
      content: JSON.stringify(
        {
          name: `${ctx.slug}-fe`,
          version: '0.1.0',
          private: true,
          scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
          dependencies: { next: '^15.0.0', react: '^18.3.0', 'react-dom': '^18.3.0' },
          devDependencies: { typescript: '^5.4.0', '@types/react': '^18.3.0', '@types/node': '^20.0.0' },
        },
        null,
        2,
      ),
    },
    {
      filePath: 'next.config.mjs',
      content: `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nexport default nextConfig;\n`,
    },
    {
      filePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2021',
            lib: ['dom', 'dom.iterable', 'esnext'],
            jsx: 'preserve',
            module: 'esnext',
            moduleResolution: 'bundler',
            strict: true,
            esModuleInterop: true,
            baseUrl: '.',
            paths: { '@/*': ['./src/*'] },
          },
          include: ['src', 'next-env.d.ts'],
        },
        null,
        2,
      ),
    },
    {
      filePath: 'README.md',
      content: `# ${ctx.companyName} — Frontend\n\nNext.js (App Router) scaffolded by DevFlow.\n\n## Structure\n\n\`\`\`\nsrc/\n  app/         # routes & layouts (view)\n  components/  # reusable UI\n  hooks/       # view-model hooks (state + data)\n  lib/         # api clients & utils (model)\n\`\`\`\n`,
    },
    {
      filePath: 'src/app/layout.tsx',
      content: `export const metadata = { title: '${ctx.companyName}' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    },
    {
      filePath: 'src/app/page.tsx',
      content: `import { useHealth } from '@/hooks/use-health';\n\nexport default function Home() {\n  return <main style={{ padding: 24 }}><h1>${ctx.companyName}</h1><p>Scaffolded by DevFlow.</p></main>;\n}\n\n// eslint-disable-next-line @typescript-eslint/no-unused-vars\nconst _keep = useHealth;\n`,
    },
    {
      filePath: 'src/lib/api.ts',
      content: `const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';\n\nexport async function api<T>(path: string): Promise<T> {\n  const res = await fetch(\`\${API_URL}\${path}\`);\n  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);\n  return res.json() as Promise<T>;\n}\n`,
    },
    {
      filePath: 'src/hooks/use-health.ts',
      content: `'use client';\nimport { useEffect, useState } from 'react';\nimport { api } from '@/lib/api';\n\n// A view-model hook: owns state + data fetching for a view.\nexport function useHealth() {\n  const [status, setStatus] = useState<string>('loading');\n  useEffect(() => {\n    api<{ status: string }>('/health').then((r) => setStatus(r.status)).catch(() => setStatus('error'));\n  }, []);\n  return { status };\n}\n`,
    },
    { filePath: 'src/components/.gitkeep', content: '' },
  ];
}

function mobile(ctx: ScaffoldContext): ScaffoldFile[] {
  const expoIgnore = `${NODE_IGNORE}\n# expo\n.expo/\n.expo-shared/\nweb-build/\n*.orig.*\n`;
  return [
    { filePath: '.gitignore', content: expoIgnore },
    { filePath: '.env.example', content: `EXPO_PUBLIC_API_URL=http://localhost:4000\n` },
    {
      filePath: 'package.json',
      content: JSON.stringify(
        {
          name: `${ctx.slug}-mobile`,
          version: '0.1.0',
          private: true,
          main: 'expo-router/entry',
          scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios' },
          dependencies: { expo: '^51.0.0', react: '18.2.0', 'react-native': '0.74.0' },
          devDependencies: { typescript: '^5.4.0', '@types/react': '^18.2.0' },
        },
        null,
        2,
      ),
    },
    {
      filePath: 'app.json',
      content: JSON.stringify(
        { expo: { name: ctx.companyName, slug: `${ctx.slug}-mobile`, version: '0.1.0' } },
        null,
        2,
      ),
    },
    {
      filePath: 'tsconfig.json',
      content: JSON.stringify(
        { compilerOptions: { strict: true, jsx: 'react-native', baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
        null,
        2,
      ),
    },
    {
      filePath: 'README.md',
      content: `# ${ctx.companyName} — Mobile\n\nExpo / React Native scaffolded by DevFlow (MVVM).\n\n\`\`\`\nApp.tsx\nsrc/\n  features/<feature>/\n    <feature>-view.tsx        # View (UI)\n    use-<feature>-view-model.ts  # ViewModel (state + logic)\n  lib/                        # api clients (model)\n\`\`\`\n`,
    },
    {
      filePath: 'App.tsx',
      content: `import { HomeView } from './src/features/home/home-view';\n\nexport default function App() {\n  return <HomeView />;\n}\n`,
    },
    {
      filePath: 'src/features/home/use-home-view-model.ts',
      content: `import { useEffect, useState } from 'react';\nimport { api } from '../../lib/api';\n\n// ViewModel: owns state + logic, keeps the View dumb.\nexport function useHomeViewModel() {\n  const [status, setStatus] = useState('loading');\n  useEffect(() => {\n    api<{ status: string }>('/health').then((r) => setStatus(r.status)).catch(() => setStatus('error'));\n  }, []);\n  return { status };\n}\n`,
    },
    {
      filePath: 'src/features/home/home-view.tsx',
      content: `import { Text, View } from 'react-native';\nimport { useHomeViewModel } from './use-home-view-model';\n\nexport function HomeView() {\n  const vm = useHomeViewModel();\n  return (\n    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>\n      <Text>${ctx.companyName}</Text>\n      <Text>API: {vm.status}</Text>\n    </View>\n  );\n}\n`,
    },
    {
      filePath: 'src/lib/api.ts',
      content: `const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';\n\nexport async function api<T>(path: string): Promise<T> {\n  const res = await fetch(\`\${API_URL}\${path}\`);\n  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);\n  return res.json() as Promise<T>;\n}\n`,
    },
  ];
}

function backendNode(ctx: ScaffoldContext): ScaffoldFile[] {
  return [
    { filePath: '.gitignore', content: NODE_IGNORE },
    { filePath: '.env.example', content: `PORT=4000\nNODE_ENV=development\nDATABASE_URL=\n` },
    {
      filePath: 'package.json',
      content: JSON.stringify(
        {
          name: `${ctx.slug}-be`,
          version: '0.1.0',
          private: true,
          scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'ts-node-dev src/index.ts' },
          dependencies: { express: '^4.19.0' },
          devDependencies: {
            typescript: '^5.4.0',
            'ts-node-dev': '^2.0.0',
            '@types/express': '^4.17.0',
            '@types/node': '^20.0.0',
          },
        },
        null,
        2,
      ),
    },
    {
      filePath: 'tsconfig.json',
      content: JSON.stringify(
        { compilerOptions: { target: 'ES2021', module: 'commonjs', outDir: 'dist', strict: true, esModuleInterop: true } },
        null,
        2,
      ),
    },
    {
      filePath: 'README.md',
      content: `# ${ctx.companyName} — Backend (Node / Express)\n\nLayered: routes (controller) -> services -> repositories. See \`src/modules/health/\`.\n`,
    },
    {
      filePath: 'src/index.ts',
      content: `import express from 'express';\nimport { healthRouter } from './modules/health/health.controller';\n\nconst app = express();\napp.use(express.json());\napp.use('/health', healthRouter);\napp.listen(process.env.PORT ?? 4000);\n`,
    },
    {
      filePath: 'src/modules/health/health.controller.ts',
      content: `import { Router } from 'express';\nimport { healthService } from './health.service';\n\n// Controller: HTTP in/out only.\nexport const healthRouter = Router();\nhealthRouter.get('/', (_req, res) => res.json(healthService.status()));\n`,
    },
    {
      filePath: 'src/modules/health/health.service.ts',
      content: `// Service: business logic.\nexport const healthService = {\n  status() {\n    return { status: 'ok', ts: new Date().toISOString() };\n  },\n};\n`,
    },
  ];
}

function frontendReact(ctx: ScaffoldContext): ScaffoldFile[] {
  const viteIgnore = `${NODE_IGNORE}\n# vite\n.vite/\n`;
  return [
    { filePath: '.gitignore', content: viteIgnore },
    { filePath: '.env.example', content: `VITE_API_URL=http://localhost:4000\n` },
    {
      filePath: 'package.json',
      content: JSON.stringify(
        {
          name: `${ctx.slug}-fe`,
          version: '0.1.0',
          private: true,
          type: 'module',
          scripts: { dev: 'vite', build: 'tsc && vite build', preview: 'vite preview' },
          dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' },
          devDependencies: {
            vite: '^5.0.0',
            '@vitejs/plugin-react': '^4.0.0',
            typescript: '^5.4.0',
            '@types/react': '^18.3.0',
            '@types/react-dom': '^18.3.0',
          },
        },
        null,
        2,
      ),
    },
    {
      filePath: 'vite.config.ts',
      content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
    },
    {
      filePath: 'tsconfig.json',
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2021',
            lib: ['dom', 'dom.iterable', 'esnext'],
            jsx: 'react-jsx',
            module: 'esnext',
            moduleResolution: 'bundler',
            strict: true,
            baseUrl: '.',
            paths: { '@/*': ['./src/*'] },
          },
          include: ['src'],
        },
        null,
        2,
      ),
    },
    {
      filePath: 'index.html',
      content: `<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><title>${ctx.companyName}</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n`,
    },
    {
      filePath: 'README.md',
      content: `# ${ctx.companyName} — Frontend (React + Vite)\n\n\`\`\`\nsrc/ App.tsx, components/, hooks/ (view-model), lib/ (api)\n\`\`\`\n`,
    },
    {
      filePath: 'src/main.tsx',
      content: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { App } from './App';\n\ncreateRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
    },
    {
      filePath: 'src/App.tsx',
      content: `import { useHealth } from './hooks/useHealth';\n\nexport function App() {\n  const { status } = useHealth();\n  return (\n    <main style={{ padding: 24 }}>\n      <h1>${ctx.companyName}</h1>\n      <p>API: {status}</p>\n    </main>\n  );\n}\n`,
    },
    {
      filePath: 'src/lib/api.ts',
      content: `const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';\n\nexport async function api<T>(path: string): Promise<T> {\n  const res = await fetch(\`\${API_URL}\${path}\`);\n  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);\n  return res.json() as Promise<T>;\n}\n`,
    },
    {
      filePath: 'src/hooks/useHealth.ts',
      content: `import { useEffect, useState } from 'react';\nimport { api } from '../lib/api';\n\nexport function useHealth() {\n  const [status, setStatus] = useState('loading');\n  useEffect(() => {\n    api<{ status: string }>('/health').then((r) => setStatus(r.status)).catch(() => setStatus('error'));\n  }, []);\n  return { status };\n}\n`,
    },
  ];
}

function mobileReactNative(ctx: ScaffoldContext): ScaffoldFile[] {
  const rnIgnore = `${NODE_IGNORE}\n# react-native\nios/Pods/\n*.keystore\n*.jsbundle\n`;
  return [
    { filePath: '.gitignore', content: rnIgnore },
    { filePath: '.env.example', content: `API_URL=http://localhost:4000\n` },
    {
      filePath: 'package.json',
      content: JSON.stringify(
        {
          name: `${ctx.slug}-mobile`,
          version: '0.1.0',
          private: true,
          scripts: { start: 'react-native start', android: 'react-native run-android', ios: 'react-native run-ios' },
          dependencies: { react: '18.2.0', 'react-native': '0.74.0' },
          devDependencies: { typescript: '^5.4.0', '@types/react': '^18.2.0' },
        },
        null,
        2,
      ),
    },
    { filePath: 'app.json', content: JSON.stringify({ name: `${ctx.slug}-mobile`, displayName: ctx.companyName }, null, 2) },
    {
      filePath: 'index.js',
      content: `import { AppRegistry } from 'react-native';\nimport App from './App';\nimport { name as appName } from './app.json';\n\nAppRegistry.registerComponent(appName, () => App);\n`,
    },
    {
      filePath: 'tsconfig.json',
      content: JSON.stringify(
        { compilerOptions: { strict: true, jsx: 'react-native', baseUrl: '.', paths: { '@/*': ['./src/*'] } } },
        null,
        2,
      ),
    },
    {
      filePath: 'README.md',
      content: `# ${ctx.companyName} — Mobile (React Native CLI)\n\nMVVM: \`src/features/<feature>/{<feature>-view.tsx, use-<feature>-view-model.ts}\`, \`src/lib/\` (api).\n`,
    },
    { filePath: 'App.tsx', content: `import { HomeView } from './src/features/home/home-view';\n\nexport default function App() {\n  return <HomeView />;\n}\n` },
    {
      filePath: 'src/features/home/use-home-view-model.ts',
      content: `import { useEffect, useState } from 'react';\nimport { api } from '../../lib/api';\n\nexport function useHomeViewModel() {\n  const [status, setStatus] = useState('loading');\n  useEffect(() => {\n    api<{ status: string }>('/health').then((r) => setStatus(r.status)).catch(() => setStatus('error'));\n  }, []);\n  return { status };\n}\n`,
    },
    {
      filePath: 'src/features/home/home-view.tsx',
      content: `import { Text, View } from 'react-native';\nimport { useHomeViewModel } from './use-home-view-model';\n\nexport function HomeView() {\n  const vm = useHomeViewModel();\n  return (\n    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>\n      <Text>${ctx.companyName}</Text>\n      <Text>API: {vm.status}</Text>\n    </View>\n  );\n}\n`,
    },
    {
      filePath: 'src/lib/api.ts',
      content: `const API_URL = process.env.API_URL ?? 'http://localhost:4000';\n\nexport async function api<T>(path: string): Promise<T> {\n  const res = await fetch(\`\${API_URL}\${path}\`);\n  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);\n  return res.json() as Promise<T>;\n}\n`,
    },
  ];
}

/** Available stack variants per repo kind (first is the default). */
export const STACK_OPTIONS: Record<RepositoryKind, string[]> = {
  [RepositoryKind.BACKEND]: ['nest', 'node'],
  [RepositoryKind.FRONTEND]: ['next', 'react'],
  [RepositoryKind.MOBILE]: ['expo', 'react-native'],
};

const BUILDERS: Record<string, (ctx: ScaffoldContext) => ScaffoldFile[]> = {
  'BACKEND:nest': backend,
  'BACKEND:node': backendNode,
  'FRONTEND:next': frontend,
  'FRONTEND:react': frontendReact,
  'MOBILE:expo': mobile,
  'MOBILE:react-native': mobileReactNative,
};

export function isValidStack(kind: RepositoryKind, stack: string): boolean {
  return STACK_OPTIONS[kind].includes(stack.toLowerCase());
}

export function scaffoldFilesFor(
  kind: RepositoryKind,
  stack: string | null | undefined,
  ctx: ScaffoldContext,
): ScaffoldFile[] {
  const variant = (stack || STACK_OPTIONS[kind][0]).toLowerCase();
  const builder = BUILDERS[`${kind}:${variant}`] ?? BUILDERS[`${kind}:${STACK_OPTIONS[kind][0]}`];
  return builder(ctx);
}
