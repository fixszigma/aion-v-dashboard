import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(__dirname, '..');

test('DOM references between index.html and app.js', () => {
  const html = fs.readFileSync(path.join(dashboardDir, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(dashboardDir, 'js/app.js'), 'utf8');

  // Match $('#id')
  const idRegex = /\$\(['"]#([a-zA-Z0-9_-]+)['"]\)/g;
  const ids = [...new Set([...app.matchAll(idRegex)].map(m => m[1]))];

  const missing = ids.filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `Missing IDs in HTML: ${missing.join(', ')}`);
});

test('PWA manifest and Service Worker references', () => {
  assert.ok(fs.existsSync(path.join(dashboardDir, 'manifest.webmanifest')), 'manifest exists');
  assert.ok(fs.existsSync(path.join(dashboardDir, 'sw.js')), 'sw.js exists');
  assert.ok(fs.existsSync(path.join(dashboardDir, 'icons/icon.svg')), 'icon exists');

  const sw = fs.readFileSync(path.join(dashboardDir, 'sw.js'), 'utf8');
  assert.ok(sw.includes('aionv-obd-v1'));
});
