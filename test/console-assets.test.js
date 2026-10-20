import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('web console contains authenticated live stream, filters and export', () => {
  const html = readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  assert.match(html, /Bridge Console 2\.2/);
  assert.match(html, /\/api\/console\/stream/);
  assert.match(html, /\/api\/console\/events/);
  assert.match(html, /\/api\/console\/export/);
  assert.match(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.match(html, /\/api\/tgk/);
  assert.match(html, /\/api\/console\/network\/test/);
  assert.match(html, /Активные операции/);
  assert.match(html, /--primary:#ffd35a/);
});

test('desktop console is a one-click Windows WPF client of the same API', () => {
  const script = readFileSync(new URL('../desktop/BridgeConsole.ps1', import.meta.url), 'utf8');
  const launcher = readFileSync(new URL('../desktop/BridgeConsole.cmd', import.meta.url), 'utf8');
  assert.match(script, /PresentationFramework/);
  assert.match(script, /\/api\/console\/events/);
  assert.match(script, /PANEL_TOKEN/);
  assert.match(launcher, /BridgeConsole\.ps1/);
});
