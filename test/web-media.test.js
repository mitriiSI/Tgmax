import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseVideoRelayPlan } from '../src/web-media.js';

const MIB = 1024 * 1024;

test('short web video keeps the highest available resolution when it fits', () => {
  const plan = chooseVideoRelayPlan({
    duration: 20,
    sourceHeight: 1080,
    targetBytes: 19 * MIB
  });
  assert.equal(plan.parts, 1);
  assert.equal(plan.height, 1080);
  assert.ok(plan.videoBitrateKbps >= 1200);
});

test('very long web video is split while preserving the 360p floor', () => {
  const plan = chooseVideoRelayPlan({
    duration: 2 * 60 * 60,
    sourceHeight: 1080,
    targetBytes: 19 * MIB
  });
  assert.ok(plan.parts > 1);
  assert.equal(plan.height, 360);
  assert.ok(plan.videoBitrateKbps >= 320);
});
