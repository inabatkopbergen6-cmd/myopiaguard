#!/usr/bin/env node
/**
 * Development runner: the API with `--watch`, and Vite for the SPA.
 *
 * Vite proxies /api and /live to the server, so the browser sees a single origin
 * in development exactly as it does in production — no CORS to get subtly wrong,
 * and no base-URL switch between environments.
 *
 * Both children are launched with `process.execPath` and a JS entry point rather
 * than through an npm/shell wrapper: that keeps the process tree cancellable on
 * Windows, avoids `shell: true` argument-joining, and makes Ctrl+C actually stop
 * the servers instead of leaving orphans on the ports.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];

function run(name, args, { cwd, color }) {
  const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(`${prefix}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('error', (error) => {
    process.stderr.write(`${prefix}failed to start: ${error.message}\n`);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (!shuttingDown) process.stdout.write(`${prefix}exited with code ${code}\n`);
    shutdown(code ?? 0);
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('');
console.log('  MyopiaGuard development');
console.log('  API   http://localhost:4000   (restarts on change)');
console.log('  Web   http://localhost:5173   (proxies /api and /live)');
console.log('  Open the web address, not the API address — the API serves no UI in dev.');
console.log('  No data yet? Stop this and run: npm run seed:demo -- --force');
console.log('');

run('api', ['--watch', path.join(repoRoot, 'server', 'src', 'index.js')], {
  cwd: path.join(repoRoot, 'server'),
  color: '36',
});
run('web', [path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')], {
  cwd: path.join(repoRoot, 'web'),
  color: '35',
});
