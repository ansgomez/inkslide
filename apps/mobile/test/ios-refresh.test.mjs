// Inkslide mobile - checks of the iPad refresh agent's pure parts (scripts/ios-refresh.mjs):
// renewal decision, device reachability, dev-server detection, the launchd plist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentPlist, deviceReachable, devServerRunning, INTERVAL_S, LABEL, needsRenewal, pairedDevices, paths, RENEW_BEFORE_MS,
} from '../scripts/ios-refresh.mjs';

const H = 3600e3;
const dev = (id, tunnelState, pairingState = 'paired', platform = 'iOS') => ({
  identifier: id,
  deviceProperties: { name: 'iPad' },
  hardwareProperties: { platform, udid: `udid-${id}`, marketingName: 'iPad Air' },
  connectionProperties: { pairingState, tunnelState },
});
const list = (...devices) => ({ result: { devices } });

test('renews only within RENEW_BEFORE_MS of the expiry, or when the expiry is unknown', () => {
  const now = Date.parse('2026-11-24T00:00:00Z');
  assert.equal(needsRenewal(now + RENEW_BEFORE_MS + H, now), false);
  assert.equal(needsRenewal(now + RENEW_BEFORE_MS, now), true);
  assert.equal(needsRenewal(now - H, now), true);
  assert.equal(needsRenewal(NaN, now), true);
});

test('a device is reachable when paired and its tunnel is not unavailable', () => {
  assert.equal(deviceReachable(list(dev('A', 'connected')), 'A'), true);
  assert.equal(deviceReachable(list(dev('A', 'disconnected')), 'A'), true); // reachable, tunnel not up yet
  assert.equal(deviceReachable(list(dev('A', 'unavailable')), 'A'), false);
  assert.equal(deviceReachable(list(dev('A', 'connected', 'unpaired')), 'A'), false);
  assert.equal(deviceReachable(list(dev('A', 'connected')), 'B'), false);
  assert.equal(deviceReachable(list(dev('A', 'connected')), 'udid-A'), true);
  assert.equal(deviceReachable({}, 'A'), false);
});

test('pairedDevices lists paired iOS devices only', () => {
  const l = pairedDevices(list(dev('A', 'unavailable'), dev('B', 'connected', 'unpaired'), dev('C', 'connected', 'paired', 'macOS')));
  assert.deepEqual(l, [{ id: 'A', name: 'iPad', model: 'iPad Air' }]);
});

test('detects a running tauri ios dev', () => {
  assert.equal(devServerRunning('node /x/node_modules/@tauri-apps/cli/tauri.js ios dev\n'), true);
  assert.equal(devServerRunning('/bin/sh -c tauri ios dev'), true);
  assert.equal(devServerRunning('node tauri.js ios build --export-method debugging'), false);
  assert.equal(devServerRunning('vim ios devlog.txt'), false);
});

test('paths stay under the given home', () => {
  const p = paths('/home/test');
  for (const v of Object.values(p)) assert.ok(v.startsWith('/home/test/Library/'), v);
  assert.ok(p.plist.endsWith(`LaunchAgents/${LABEL}.plist`));
});

test('the agent plist is valid, escaped, and runs `run` at background priority', () => {
  const s = agentPlist({ node: '/n/node', script: '/a & b/ios-refresh.mjs', pathEnv: '/n:/usr/bin', log: '/l/x.log' });
  assert.match(s, /<string>\/a &amp; b\/ios-refresh\.mjs<\/string><string>run<\/string>/);
  assert.match(s, new RegExp(`<integer>${INTERVAL_S}</integer>`));
  assert.match(s, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(s, /<key>CARGO_BUILD_JOBS<\/key><string>2<\/string>/);
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'inkslide-plist-'));
    try {
      const f = join(dir, 'agent.plist');
      writeFileSync(f, s);
      const r = spawnSync('plutil', ['-lint', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
