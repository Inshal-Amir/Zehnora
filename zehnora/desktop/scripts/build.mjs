import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

const watch = process.argv.includes('--main-only');
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: 'linked', logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/main/preload.js' }),
]);
if (!watch) await viteBuild({ configFile: 'vite.config.mts', logLevel: 'warn' });
console.log('built dist/main and dist/renderer');
