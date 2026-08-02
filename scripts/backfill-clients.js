/**
 * One-off backfill: give every client-less project a Client, derived from its companyName.
 *
 * Safe to re-run. Projects that already have a clientId are skipped, and companies are matched
 * case-insensitively so two projects for "Acme" and "acme" land on the same client rather than
 * creating the duplicates this entity exists to prevent.
 *
 *   node scripts/backfill-clients.js          # report only
 *   node scripts/backfill-clients.js --apply  # write
 */
const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  try {
    const projects = await prisma.project.findMany({
      where: { clientId: null },
      select: { id: true, companyName: true, createdById: true },
      orderBy: { createdAt: 'asc' },
    });

    if (projects.length === 0) {
      console.log('No client-less projects. Nothing to do.');
      return;
    }

    console.log(`${projects.length} project(s) without a client:`);
    for (const project of projects) console.log(`  - ${project.companyName} (${project.id})`);

    if (!APPLY) {
      console.log('\nDry run. Re-run with --apply to create clients and link them.');
      return;
    }

    let created = 0;
    let linked = 0;
    for (const project of projects) {
      const name = project.companyName.trim();
      // `mode: 'insensitive'` so re-runs and near-duplicate casings reuse one client.
      const existing = await prisma.client.findFirst({
        where: { name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      });

      const client =
        existing ??
        (await prisma.client.create({
          data: { name, status: 'ACTIVE', createdById: project.createdById },
          select: { id: true },
        }));
      if (!existing) created += 1;

      await prisma.project.update({ where: { id: project.id }, data: { clientId: client.id } });
      linked += 1;
      console.log(`  linked ${project.companyName} -> client ${client.id}${existing ? ' (existing)' : ' (new)'}`);
    }

    console.log(`\nDone. ${created} client(s) created, ${linked} project(s) linked.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Backfill failed:', error.message);
  process.exit(1);
});
