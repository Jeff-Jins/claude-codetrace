// Bundles the CLI/server and the web UI into dist/. Pass --watch to rebuild on change.

import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await rm('dist', { recursive: true, force: true });
await mkdir('dist/web', { recursive: true });

const copyStatic = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async () => {
      await cp('src/web/index.html', 'dist/web/index.html');
      await cp('src/web/styles.css', 'dist/web/styles.css');
    });
  },
};

const configs = [
  {
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entryPoints: ['src/web/main.ts'],
    outfile: 'dist/web/main.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    plugins: [copyStatic],
  },
];

if (watch) {
  for (const config of configs) await (await esbuild.context(config)).watch();
  console.log('Watching for changes…');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
  console.log('Built dist/');
}
