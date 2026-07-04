import { describe, it, expect } from 'vitest';
import {
  checkIntegration,
  extractBackendRoutes,
  extractFrontendApiCalls,
  extractPrismaModels,
  extractPrismaModelAccess,
  type IntegrationArtifact,
} from './integration.checker';

const backend = (filePath: string, content: string): IntegrationArtifact => ({ agentType: 'backend', filePath, content });
const frontend = (filePath: string, content: string): IntegrationArtifact => ({ agentType: 'frontend', filePath, content });
const database = (filePath: string, content: string): IntegrationArtifact => ({ agentType: 'database', filePath, content });

describe('extraction helpers', () => {
  it('builds full routes from a controller base + method decorators', () => {
    const routes = extractBackendRoutes(
      `@Controller('orders')\nexport class OrdersController {\n  @Get() list() {}\n  @Get(':id') one() {}\n  @Post() create() {}\n}`,
    );
    expect(routes).toEqual(['/orders', '/orders/:id', '/orders']);
  });

  it('extracts fetch and axios call paths, ignoring external URLs', () => {
    const calls = extractFrontendApiCalls(
      "const a = fetch('/api/orders');\n" +
        'const b = axios.get(`/api/orders/${id}`);\n' +
        "const c = fetch('https://stripe.com/v1/charges');\n" +
        "const d = fetch('not-a-path');",
    );
    expect(calls).toContain('/api/orders');
    expect(calls).toContain('/api/orders/${id}');
    expect(calls).not.toContain('https://stripe.com/v1/charges');
    expect(calls).not.toContain('not-a-path');
  });

  it('extracts prisma models and accessors', () => {
    expect(extractPrismaModels('model User {\n id String\n}\nmodel Order {}')).toEqual(['User', 'Order']);
    expect(extractPrismaModelAccess('this.prisma.user.findMany(); prisma.order.create();')).toEqual(['user', 'order']);
  });
});

describe('checkIntegration — frontend ↔ backend', () => {
  it('flags a frontend call to a resource the backend never exposes', () => {
    const errors = checkIntegration([
      backend('orders.controller.ts', `@Controller('orders') class C { @Get() list() {} }`),
      frontend('page.tsx', `export default function P() { fetch('/api/invoices'); return null; }`),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'CONTRACT', agentType: 'frontend' });
    expect(errors[0].message).toContain('/api/invoices');
  });

  it('does NOT flag a frontend call that matches a backend resource (ignoring /api prefix and params)', () => {
    const errors = checkIntegration([
      backend('orders.controller.ts', `@Controller('orders') class C { @Get(':id') one() {} }`),
      frontend('page.tsx', `fetch(\`/api/orders/\${id}\`);`),
    ]);
    expect(errors).toHaveLength(0);
  });

  it('does not run the check when there is no backend (cannot conclude)', () => {
    const errors = checkIntegration([
      frontend('page.tsx', `fetch('/api/whatever');`),
    ]);
    expect(errors).toHaveLength(0);
  });
});

describe('checkIntegration — backend ↔ database', () => {
  it('flags a prisma access to an undeclared model', () => {
    const errors = checkIntegration([
      database('schema.prisma', `model User { id String @id }`),
      backend('widgets.service.ts', `class S { constructor(private prisma: P) {} all() { return this.prisma.widget.findMany(); } }`),
    ]);
    const dbError = errors.find((e) => e.message.includes('widget'));
    expect(dbError).toMatchObject({ code: 'CONTRACT', agentType: 'backend' });
  });

  it('does NOT flag a prisma access that resolves to a declared model (plural tolerant)', () => {
    const errors = checkIntegration([
      database('schema.prisma', `model User { id String @id }\nmodel Order { id String @id }`),
      backend('orders.service.ts', `class S { a() { return this.prisma.user.findMany(); } b() { return this.prisma.orders.findMany(); } }`),
    ]);
    expect(errors).toHaveLength(0);
  });

  it('ignores prisma client utility members ($transaction etc.)', () => {
    const errors = checkIntegration([
      database('schema.prisma', `model User { id String @id }`),
      backend('svc.ts', `class S { tx() { return this.prisma.$transaction([]); } u() { return this.prisma.user.findMany(); } }`),
    ]);
    expect(errors).toHaveLength(0);
  });

  it('does not run the check when there is no schema (cannot conclude)', () => {
    const errors = checkIntegration([
      backend('svc.ts', `class S { all() { return this.prisma.widget.findMany(); } }`),
    ]);
    expect(errors).toHaveLength(0);
  });
});
