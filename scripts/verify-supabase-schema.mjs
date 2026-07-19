import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const expectedTables = {
  admin: ['admin_audit_logs', 'admin_domains', 'platform_settings'],
  collaboration: ['collaboration_documents', 'conversation_reads', 'project_conversations', 'project_messages'],
  identity: ['developer_profiles', 'profiles'],
  intake: ['client_inquiries', 'client_invites'],
  integration: ['idempotency_records', 'integration_outbox'],
  memory: ['agent_memories', 'agent_profiles'],
  notifications: ['notifications'],
  orchestration: [
    'checkpoint_blobs',
    'checkpoint_migrations',
    'checkpoint_writes',
    'checkpoints',
    'event_logs',
    'orchestration_jobs',
    'orchestration_runs',
    'provider_invocations',
    'run_budgets',
    'work_order_executions',
    'work_orders',
  ],
  projects: [
    'Artifact',
    'GateEvent',
    'Project',
    'project_delivery_reviews',
    'project_kickoffs',
    'project_members',
    'project_task_activities',
    'project_tasks',
    'project_timeline_events',
  ],
  scheduling: ['schedule_events'],
};

const serviceSchemas = Object.keys(expectedTables);
const allowedPublicTables = new Set(['_prisma_migrations']);

const env = loadDotEnv();
const accessToken = process.env.SUPABASE_ACCESS_TOKEN ?? env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF
  ?? env.SUPABASE_PROJECT_REF
  ?? projectRefFromUrl(env.SUPABASE_URL);

if (!accessToken) {
  fail('SUPABASE_ACCESS_TOKEN is required to verify the live schema.');
}

if (!projectRef) {
  fail('SUPABASE_PROJECT_REF or SUPABASE_URL is required to verify the live schema.');
}

const rows = await executeSql(`
select table_schema, table_name
from information_schema.tables
where table_type = 'BASE TABLE'
  and table_schema in (${[...serviceSchemas, 'public'].map((schema) => quoteLiteral(schema)).join(', ')})
order by table_schema, table_name;
`);

const grants = await executeSql(`
select n.nspname as schema,
  has_schema_privilege('anon', n.oid, 'USAGE') as anon_usage,
  has_schema_privilege('authenticated', n.oid, 'USAGE') as authenticated_usage
from pg_namespace n
where n.nspname in (${serviceSchemas.map((schema) => quoteLiteral(schema)).join(', ')})
order by n.nspname;
`);

const violations = [
  ...findTablePlacementViolations(rows),
  ...findGrantViolations(grants),
];

if (violations.length > 0) {
  fail(`Live Supabase schema verification failed:\n${violations.map((violation) => `- ${violation}`).join('\n')}`);
}

console.log('Live Supabase schema verification passed.');
console.log(JSON.stringify(tableCounts(rows), null, 2));

async function executeSql(query) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  const text = await response.text();
  if (!response.ok) {
    fail(`Supabase query failed (${response.status}): ${text}`);
  }

  return JSON.parse(text);
}

function findTablePlacementViolations(rows) {
  const violations = [];
  const actualBySchema = new Map();

  for (const row of rows) {
    const tables = actualBySchema.get(row.table_schema) ?? new Set();
    tables.add(row.table_name);
    actualBySchema.set(row.table_schema, tables);
  }

  for (const table of actualBySchema.get('public') ?? []) {
    if (!allowedPublicTables.has(table)) {
      violations.push(`unexpected public table: ${table}`);
    }
  }

  for (const [schema, expected] of Object.entries(expectedTables)) {
    const actual = actualBySchema.get(schema) ?? new Set();
    for (const table of expected) {
      if (!actual.has(table)) {
        violations.push(`missing ${schema}.${table}`);
      }
    }

    for (const table of actual) {
      if (!expected.includes(table)) {
        violations.push(`unexpected ${schema}.${table}`);
      }
    }
  }

  return violations.sort();
}

function findGrantViolations(grants) {
  return grants.flatMap((grant) => {
    const violations = [];
    if (grant.anon_usage) {
      violations.push(`anon has USAGE on schema ${grant.schema}`);
    }
    if (grant.authenticated_usage) {
      violations.push(`authenticated has USAGE on schema ${grant.schema}`);
    }
    return violations;
  }).sort();
}

function tableCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.table_schema] = (counts[row.table_schema] ?? 0) + 1;
    return counts;
  }, {});
}

function loadDotEnv() {
  try {
    const file = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    return Object.fromEntries(file.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return [];
      const separator = trimmed.indexOf('=');
      if (separator === -1) return [];
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^"|"$/g, '');
      return [[key, value]];
    }));
  } catch {
    return {};
  }
}

function projectRefFromUrl(url) {
  return url?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
}

function quoteLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
