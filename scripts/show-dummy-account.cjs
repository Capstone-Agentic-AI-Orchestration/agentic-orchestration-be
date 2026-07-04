const fs = require('node:fs');
const path = require('node:path');

const fixturePath = path.join(
  __dirname,
  '..',
  'libs',
  'common',
  'src',
  'database',
  'seeds',
  'dummy-users.json',
);

if (!fs.existsSync(fixturePath)) {
  console.error('Dummy fixture file not found:', fixturePath);
  process.exit(1);
}

const fixtureRaw = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureRaw);

console.log('Dummy account fixture for manual testing');
console.log('----------------------------------------');
console.log(JSON.stringify(fixture, null, 2));

console.log('\nSuggested login payload:');
console.log(
  JSON.stringify(
    {
      email: fixture.users[0]?.email,
      password: fixture.users[0]?.password,
    },
    null,
    2,
  ),
);
