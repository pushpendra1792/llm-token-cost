import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    // Share the ESM library build instead of embedding a second copy of the
    // snapshot. The CLI runs from dist/cli.js, next to dist/index.js.
    external: ['./index.js'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
