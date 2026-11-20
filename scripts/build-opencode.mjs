// Build the self-contained OpenCode plugin from the repository's browser core.
//
// The published package must not reach outside its own directory, so this build
// copies the one shared core into plugins/opencode-moli/dist/lib and copies the
// adapter alongside it. It mirrors scripts/build-codex.mjs; keep the two in sync
// when the core's file list changes.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const pluginRoot = join(repo, 'plugins', 'opencode-moli');
const dist = join(pluginRoot, 'dist');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const pluginPackage = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

function ensureInside(parent, child) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (pathFromParent === '' || pathFromParent.startsWith(`..${sep}`) || pathFromParent === '..') {
    throw new Error(`refusing to write outside ${parent}: ${child}`);
  }
}

ensureInside(pluginRoot, dist);
if (pluginPackage.version !== pkg.version) {
  throw new Error(`OpenCode plugin package version ${pluginPackage.version} does not match package.json ${pkg.version}`);
}
if (pluginPackage.dependencies?.['@opencode/plugin'] === undefined) {
  throw new Error('OpenCode plugin package must declare @opencode/plugin');
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'lib'), { recursive: true });

for (const file of ['moli.js', 'install.js', 'search.js']) {
  const source = join(repo, 'lib', file);
  if (!existsSync(source)) throw new Error(`missing shared core file: ${source}`);
  copyFileSync(source, join(dist, 'lib', file));
}

const adapterSource = readFileSync(join(pluginRoot, 'src', 'index.js'), 'utf8');
const adapter = adapterSource.replaceAll('__MOLI_VERSION__', pkg.version);
if (adapter.includes('__MOLI_VERSION__')) throw new Error('adapter version placeholder was not replaced');
writeFileSync(join(dist, 'index.js'), adapter);

for (const file of ['index.js', join('lib', 'moli.js'), join('lib', 'install.js'), join('lib', 'search.js')]) {
  execFileSync(process.execPath, ['--check', join(dist, file)], { stdio: 'inherit' });
}

const relativeImports = [...adapter.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)].map(match => match[1]);
for (const specifier of relativeImports) {
  const target = resolve(dist, specifier);
  ensureInside(dist, target);
  if (!existsSync(target)) throw new Error(`built adapter imports a missing local module: ${specifier}`);
}

console.log(`Built OpenCode plugin ${pluginPackage.name}@${pluginPackage.version}`);
console.log(`  ${relative(repo, join(dist, 'index.js'))}`);
console.log(`  ${relative(repo, join(dist, 'lib', 'moli.js'))}`);
console.log(`  ${relative(repo, join(dist, 'lib', 'install.js'))}`);
console.log(`  ${relative(repo, join(dist, 'lib', 'search.js'))}`);
