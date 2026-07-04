import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, UserRole } from '@prisma/client';

function loadEnvFile() {
  const envPath = resolve(process.cwd(), '.env');
  let content = '';

  try {
    content = readFileSync(envPath, 'utf8');
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

function parseArgs() {
  const [, , email, role] = process.argv;
  const roles = Object.values(UserRole);

  if (!email || !role || !roles.includes(role)) {
    console.error('Usage: npm run auth:set-role -- <email> <CLIENT|PM|DEV|ADMIN>');
    process.exit(1);
  }

  return { email: email.toLowerCase(), role };
}

loadEnvFile();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Check devflow-be/.env.');
  process.exit(1);
}

const { email, role } = parseArgs();
const prisma = new PrismaClient();

try {
  const profile = await prisma.profile.findUnique({
    where: { email },
    select: { id: true, email: true, role: true },
  });

  if (!profile) {
    console.error(`No profile found for ${email}. Sign in once first, then run this command again.`);
    process.exit(1);
  }

  const updated = await prisma.profile.update({
    where: { id: profile.id },
    data: { role },
    select: { id: true, email: true, role: true },
  });

  console.log(`Updated ${updated.email ?? updated.id}: ${profile.role} -> ${updated.role}`);
} finally {
  await prisma.$disconnect();
}
