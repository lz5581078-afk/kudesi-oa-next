// Explicit local experiment launcher; not used by the application or deployment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const mysql = require('mysql2/promise');

(async () => {
  const [adminFile, sourceRoot] = process.argv.slice(2);
  if (!adminFile || !sourceRoot || process.env.NODE_ENV === 'production') throw new Error('Usage: node run-local.cjs <local-mysql-admin.ini> <legacy-checkout>');
  // Only parse the local client section. Never print/store credentials or copy env.
  const text = fs.readFileSync(adminFile, 'utf8');
  const section = text.match(/\[client\]([^]*?)(?=\n\s*\[|$)/i)?.[1];
  if (!section) throw new Error('Missing local client settings');
  const options = {};
  for (const line of section.split(/\r?\n/)) {
    const match = /^\s*([\w-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) options[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (options.host && !['127.0.0.1', 'localhost', '::1'].includes(options.host)) throw new Error('Refusing non-local MySQL');
  const port = Number(options.port || 3308);
  if (port !== 3308) throw new Error('This local experiment is restricted to port 3308');
  const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: options.user, password: options.password });
  const suffix = crypto.randomBytes(6).toString('hex');
  const next = `session_reuse_next_${suffix}`, legacy = `session_reuse_lab_${suffix}`;
  try {
    for (const name of [next, legacy]) await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally { await connection.end(); }
  const apiRoot = path.resolve(__dirname, '../../..');
  const root = path.resolve(apiRoot, '../..');
  console.log(JSON.stringify({ nextDatabase: next, legacyDatabase: legacy, host: '127.0.0.1', port, productionEnabled: false }));
  const run = spawnSync(process.execPath, [require.resolve('jest/bin/jest'), '--runInBand', '--runTestsByPath',
    'src/session/legacy-lab/legacy-lab.db.spec.ts', 'src/session/legacy-lab/lab-gate.spec.ts',
    'src/session/session.db.spec.ts', 'src/session/session-list.db.spec.ts', 'src/session/maintenance.db.spec.ts',
    'src/session/session-parity.db.spec.ts', 'src/session/remote.db.spec.ts', 'src/session/agent-release.db.spec.ts',
    'src/session/legacy-runtime.db.spec.ts', 'src/session/legacy-operations.db.spec.ts'], {
    cwd: apiRoot, stdio: 'inherit', timeout: 300000, env: { ...process.env, NODE_ENV: 'test', SESSION_LEGACY_LAB: '1', SESSION_LEGACY_SOURCE: path.resolve(sourceRoot),
      SESSION_LEGACY_DB: legacy, DB_NAME: next, TEST_DB_NAME: next, DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_USER: options.user,
      DB_PASSWORD: options.password, RESOURCE_DB_TEST: '1' },
  });
  const outDir = path.join(root, '.local-test');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'session-legacy-lab-latest.json'), JSON.stringify({ nextDatabase: next, legacyDatabase: legacy,
    passed: run.status === 0, scope: 'local HTTP/MySQL/old-agent protocol only', productionEnabled: false }, null, 2));
  // Retain disposable schemas for diagnosis; never drop an existing database.
  process.exitCode = run.status ?? 1;
})().catch(() => { console.error('Local lab setup failed; credentials and raw database errors suppressed.'); process.exitCode = 1; });
