import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

export const LEGACY_SOURCE_COMMIT = '0fb7fdad2f3805e3579bd4f870199c880668aaa1';
export const LEGACY_VENDOR_ROOT = path.join(__dirname, 'vendor');

interface SnapshotManifest {
  formatVersion: number;
  sourceCommit: string;
  files: Array<{ source: string; snapshot: string; sha256: string }>;
}

/** Verify the shipped sources themselves, never an external checkout. Build must
 * copy vendor/ and snapshot-manifest.json next to this compiled module. */
export function verifyLegacySnapshot(): SnapshotManifest {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, 'snapshot-manifest.json'), 'utf8')) as SnapshotManifest;
  if (manifest.formatVersion !== 1 || manifest.sourceCommit !== LEGACY_SOURCE_COMMIT || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Invalid legacy session source manifest');
  }
  const realVendor = realpathSync(LEGACY_VENDOR_ROOT);
  for (const file of manifest.files) {
    const allowedPath = /^vendor\/(?:server\/modules\/session-manager|agent\/platforms)\/[a-z0-9-]+\.js$/.test(file.snapshot)
      || file.snapshot === 'vendor/agent/config.js' || file.snapshot === 'vendor/agent/version.json';
    if (!allowedPath || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid legacy session manifest entry');
    }
    const target = realpathSync(path.join(__dirname, file.snapshot));
    const relative = path.relative(realVendor, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Legacy source escaped vendor directory');
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== file.sha256) {
      throw new Error(`Legacy session source checksum mismatch: ${file.source}`);
    }
  }
  return manifest;
}

/** Keeps relative requires inside the byte-for-byte vendor tree. No D: checkout,
 * legacy server bootstrap, schema initializer or secret defaults are loaded. */
export function loadLegacySessionModule(name: string): Record<string, any> {
  if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new Error('Invalid legacy session module name');
  const manifest = verifyLegacySnapshot();
  const relative = `vendor/server/modules/session-manager/${name}.js`;
  if (!manifest.files.some(file => file.snapshot === relative)) throw new Error('Unknown legacy session module');
  const load = createRequire(__filename);
  return load(path.join(__dirname, relative)) as Record<string, any>;
}
