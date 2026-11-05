import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBuildInfo } from '../core/controller';
import { ensureSpawnHelper } from '../electron/terminals';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-pack-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function helper(rel: string, mode: number): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, mode);
  return p;
}

describe('node-pty spawn-helper permissions', () => {
  it('restores the execute bit at runtime', () => {
    const p = helper('node-pty/prebuilds/darwin-arm64/spawn-helper', 0o644);
    expect(ensureSpawnHelper(path.join(root, 'node-pty'), 'darwin-arm64')).toBeUndefined();
    expect(fs.statSync(p).mode & 0o777).toBe(0o755);
  });

  it('afterPack fixes every spawn-helper inside the packed app', async () => {
    const a = helper('CCVM.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper', 0o644);
    const b = helper('CCVM.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper', 0o600);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const hook = require('../build/after-pack.cjs') as { default: (ctx: { appOutDir: string }) => Promise<void> };
    await hook.default({ appOutDir: root });
    expect(fs.statSync(a).mode & 0o777).toBe(0o755);
    expect(fs.statSync(b).mode & 0o777).toBe(0o755);
  });
});

describe('build info', () => {
  it('reads commit and dirty flag, ignores anything malformed', () => {
    expect(parseBuildInfo('commit=3f3ad9de282e\ndirty=1\nbuilt=2026-11-05T07:03:53.104Z\n')).toEqual({ commit: '3f3ad9de282e', dirty: true, built: '2026-11-05T07:03:53.104Z' });
    expect(parseBuildInfo('commit=abc\n')).toBeUndefined();
    expect(parseBuildInfo('commit=$(id)\ndirty=0\n')).toBeUndefined();
    expect(parseBuildInfo(undefined)).toBeUndefined();
  });
});

describe('macOS packaging for Ghostty automation', () => {
  it('declares the Apple Events usage string and entitlement (hardened runtime denies silently without them)', async () => {
    const YAML = (await import('yaml')).default;
    const cfg = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8'));
    expect(cfg.mac.hardenedRuntime).toBe(true);
    expect(cfg.mac.extendInfo.NSAppleEventsUsageDescription).toMatch(/Ghostty/);
    for (const key of ['entitlements', 'entitlementsInherit']) {
      const plist = fs.readFileSync(path.join(__dirname, '..', cfg.mac[key]), 'utf8');
      expect(plist).toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/);
      expect(plist).toMatch(/<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
    }
  });
});
