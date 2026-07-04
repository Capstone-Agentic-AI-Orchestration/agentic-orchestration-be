#!/usr/bin/env node
/**
 * GitHub App creator for the Capstone-Agentic-AI-Orchestration org.
 *
 * Automates the GitHub App "manifest flow", which is the ONLY programmatic way
 * to create a GitHub App (there is no plain REST "create app" endpoint, and
 * OAuth Apps have no creation API at all — those are done by hand, see README).
 *
 * Usage:
 *   node create-github-app.mjs create <test|uat|main>
 *       Opens a browser to a pre-filled manifest form. You click "Create GitHub
 *       App" once; GitHub redirects back here with a one-time code, which the
 *       script exchanges for the app's id, private key, client id/secret and
 *       webhook secret — all written to ./credentials/<env>.env (gitignored).
 *
 *   node create-github-app.mjs installation <test|uat|main>
 *       Run AFTER you have installed the app on the org. Mints an app JWT from
 *       the saved private key and resolves the org installation id, appending
 *       GITHUB_INSTALLATION_ID to ./credentials/<env>.env.
 *
 * No external dependencies — Node 18+ (global fetch + node:crypto) only.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'environments.json'), 'utf8'));
const CRED_DIR = join(HERE, 'credentials');

const VALID_ENVS = ['test', 'uat', 'main'];

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function envConfig(env) {
  const cfg = CONFIG.environments[env];
  if (!cfg) die(`Unknown environment "${env}". Use one of: ${VALID_ENVS.join(', ')}`);
  const missing = ['frontendUrl', 'apiUrl'].filter(
    (k) => !cfg[k] || String(cfg[k]).includes('REPLACE'),
  );
  if (missing.length) {
    die(
      `environments.json → "${env}" still has placeholder values for: ${missing.join(', ')}.\n` +
        `    Fill in the real Vercel/Render URLs before running.`,
    );
  }
  return cfg;
}

function buildManifest(env, cfg, port) {
  // GitHub App names are globally unique across all of GitHub. If one is taken,
  // GitHub will reject it and you can rename in the confirmation screen.
  return {
    name: `agentic-orchestration-${env}`,
    url: cfg.frontendUrl,
    hook_attributes: {
      url: `${cfg.apiUrl.replace(/\/+$/, '')}/github/webhooks`,
      active: false, // no inbound webhook consumer today; flip to true when one exists
    },
    redirect_url: `http://localhost:${port}/callback`,
    public: false,
    // Permissions mirror what the artifact-push GithubService needs. Trim/extend
    // as the integration grows — you can also edit these on the app later.
    default_permissions: {
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
      workflows: 'write',
    },
    default_events: [],
  };
}

function htmlAttrEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function openBrowser(url) {
  // execFile with an argument array — no shell string is constructed, so nothing
  // in `url` can be interpreted as a shell metacharacter.
  const [file, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(file, args, (err) => {
    if (err) console.log(`  (Could not auto-open a browser — open this URL manually:)\n  ${url}`);
  });
}

function writeCredentials(env, data) {
  if (!existsSync(CRED_DIR)) mkdirSync(CRED_DIR, { recursive: true });
  const pemB64 = Buffer.from(data.pem, 'utf8').toString('base64');
  const lines = [
    `# Generated ${new Date().toISOString()} for environment: ${env}`,
    `# App: https://github.com/apps/${data.slug}`,
    `GITHUB_ORG="${CONFIG.org}"`,
    `GITHUB_APP_ID="${data.id}"`,
    `GITHUB_APP_SLUG="${data.slug}"`,
    `GITHUB_APP_CLIENT_ID="${data.client_id}"`,
    `GITHUB_APP_CLIENT_SECRET="${data.client_secret}"`,
    `GITHUB_WEBHOOK_SECRET="${data.webhook_secret ?? ''}"`,
    `# Private key, base64-encoded PEM (matches .env.example convention)`,
    `GITHUB_PRIVATE_KEY="${pemB64}"`,
    `# INSTALLATION_ID pending — install the app, then run:`,
    `#   node create-github-app.mjs installation ${env}`,
    '',
  ];
  const file = join(CRED_DIR, `${env}.env`);
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

// ── create ────────────────────────────────────────────────────────────────
async function create(env) {
  const cfg = envConfig(env);
  const port = CONFIG.localCallbackPort || 8790;
  const state = crypto.randomBytes(16).toString('hex');
  const manifest = buildManifest(env, cfg, port);
  const orgFormUrl = `https://github.com/organizations/${CONFIG.org}/settings/apps/new?state=${state}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/') {
      // Auto-submitting form that POSTs the manifest to GitHub.
      const body = `<!doctype html><html><body onload="document.forms[0].submit()">
        <p>Redirecting you to GitHub to create <b>agentic-orchestration-${env}</b>…</p>
        <form action="${orgFormUrl}" method="post">
          <input type="hidden" name="manifest" value="${htmlAttrEscape(JSON.stringify(manifest))}">
          <button type="submit">Continue to GitHub</button>
        </form></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
      return;
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (returnedState !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<p>State mismatch or missing code. Close this tab and retry.</p>');
        return;
      }
      try {
        const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'agentic-orchestration-app-creator',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (!resp.ok) throw new Error(`Conversion failed: ${resp.status} ${await resp.text()}`);
        const data = await resp.json();
        const file = writeCredentials(env, data);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!doctype html><body style="font-family:sans-serif">
           <h2>✓ Created agentic-orchestration-${env}</h2>
           <p>App id <b>${data.id}</b>. Credentials written to <code>credentials/${env}.env</code>.</p>
           <p>Next: <a href="https://github.com/apps/${data.slug}/installations/new">install it on the org</a>,
              then run <code>node create-github-app.mjs installation ${env}</code>.</p>
           <p>You can close this tab.</p></body>`,
        );
        console.log(`\n  ✓ App created. Credentials → ${file}`);
        console.log(`  → Install:  https://github.com/apps/${data.slug}/installations/new`);
        console.log(`  → Then run: node create-github-app.mjs installation ${env}\n`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<pre>${String(e)}</pre>`);
        console.error(`\n  ✗ ${e}\n`);
      } finally {
        server.close();
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    const local = `http://localhost:${port}/`;
    console.log(`\n  Creating GitHub App: agentic-orchestration-${env}`);
    console.log(`  Org:      ${CONFIG.org}`);
    console.log(`  Homepage: ${cfg.frontendUrl}`);
    console.log(`  Opening ${local} — click "Create GitHub App" on GitHub when it loads.\n`);
    openBrowser(local);
  });
}

// ── installation ────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mintAppJwt(appId, pem) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(
    Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })),
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64url(
    crypto.createSign('RSA-SHA256').update(signingInput).sign(pem),
  );
  return `${signingInput}.${signature}`;
}

function readCredEnv(env) {
  const file = join(CRED_DIR, `${env}.env`);
  if (!existsSync(file)) die(`No credentials/${env}.env found. Run "create ${env}" first.`);
  const raw = readFileSync(file, 'utf8');
  const get = (key) => {
    const m = raw.match(new RegExp(`^${key}="?([^"\\n]*)"?`, 'm'));
    return m ? m[1] : null;
  };
  return { file, raw, get };
}

async function installation(env) {
  const { file, raw, get } = readCredEnv(env);
  const appId = get('GITHUB_APP_ID');
  const pemB64 = get('GITHUB_PRIVATE_KEY');
  if (!appId || !pemB64) die(`credentials/${env}.env is missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY.`);
  const pem = Buffer.from(pemB64, 'base64').toString('utf8');
  const jwt = mintAppJwt(appId, pem);

  const resp = await fetch('https://api.github.com/app/installations', {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agentic-orchestration-app-creator',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!resp.ok) die(`Could not list installations: ${resp.status} ${await resp.text()}`);
  const installs = await resp.json();
  if (!installs.length) {
    die(
      `App is not installed anywhere yet. Open the install URL printed by "create ${env}" ` +
        `(https://github.com/apps/${get('GITHUB_APP_SLUG')}/installations/new) and install it on the org.`,
    );
  }
  const match =
    installs.find((i) => i.account?.login?.toLowerCase() === CONFIG.org.toLowerCase()) || installs[0];

  const next = raw.includes('GITHUB_INSTALLATION_ID=')
    ? raw.replace(/GITHUB_INSTALLATION_ID=.*/m, `GITHUB_INSTALLATION_ID="${match.id}"`)
    : raw.replace(/\n?$/, `\nGITHUB_INSTALLATION_ID="${match.id}"\n`);
  writeFileSync(file, next, 'utf8');
  console.log(`\n  ✓ Installation id ${match.id} (account: ${match.account?.login}) → ${file}\n`);
}

// ── entry ───────────────────────────────────────────────────────────────────
const [cmd, env] = process.argv.slice(2);
if (!['create', 'installation'].includes(cmd) || !VALID_ENVS.includes(env)) {
  console.log(
    `\nUsage:\n  node create-github-app.mjs create <${VALID_ENVS.join('|')}>\n` +
      `  node create-github-app.mjs installation <${VALID_ENVS.join('|')}>\n`,
  );
  process.exit(1);
}
if (cmd === 'create') create(env);
else installation(env);
