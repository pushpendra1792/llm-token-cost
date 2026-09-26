import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface ImportExportCondition {
  types?: string;
  default?: string;
}

interface PackageExports {
  '.': {
    import?: ImportExportCondition;
    require?: ImportExportCondition;
  };
}

interface PackageManifest {
  name: string;
  license: string;
  types: string;
  bin: Record<string, string>;
  files: string[];
  exports: PackageExports;
}

interface PricingSnapshot {
  schemaVersion: number;
  models: Record<string, unknown>;
}

const readJson = <T>(relativePath: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'),
  ) as T;

const pkg = readJson<PackageManifest>('../package.json');

describe('package manifest', () => {
  it('ships under the unscoped name and the MIT license', () => {
    expect(pkg.name).toBe('llm-token-cost');
    expect(pkg.license).toBe('MIT');
  });

  it('is published as a dual ESM/CJS package with per-condition types', () => {
    const root = pkg.exports['.'];

    expect(root.import?.types).toMatch(/\.d\.ts$/);
    expect(root.import?.default).toMatch(/\.m?js$/);
    expect(root.require?.types).toMatch(/\.d\.cts$/);
    expect(root.require?.default).toMatch(/\.cjs$/);
    expect(pkg.types).toBe(root.import?.types);
  });

  it('registers a bin entry for the CLI', () => {
    expect(pkg.bin).toMatchObject({ 'llm-token-cost': './dist/cli.js' });
  });

  it('publishes build output only, never sources', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('README.md');
    expect(pkg.files).toContain('LICENSE');
    expect(pkg.files).not.toContain('src');
  });
});

describe('source scaffold', () => {
  it('exposes the public entrypoint', async () => {
    await expect(import('../src/index')).resolves.toBeDefined();
  });

  it.each([
    ['../src/tokenizers/openai'],
    ['../src/tokenizers/anthropic'],
    ['../src/tokenizers/heuristic'],
    ['../src/pricing/fetch'],
    ['../src/budget/guardrails'],
    ['../src/cli'],
  ])('keeps %s loadable', async (specifier) => {
    await expect(import(specifier)).resolves.toBeDefined();
  });

  it('ships an empty but well-formed pricing snapshot', () => {
    const snapshot = readJson<PricingSnapshot>('../src/pricing/snapshot.json');

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.models).toEqual({});
  });
});
