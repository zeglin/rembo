// Bundles the publishable packages into single ESM files (no runtime deps).
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'esm', sourcemap: false, legalComments: 'none', logLevel: 'info' };

await build({ ...common, entryPoints: ['packages/rembo/src/cli.ts'], outfile: 'packages/rembo/dist/cli.js', target: 'node22.12' });
await build({ ...common, entryPoints: ['packages/server/src/bin.ts'], outfile: 'packages/server/dist/cli.js', target: 'node24.16' });
