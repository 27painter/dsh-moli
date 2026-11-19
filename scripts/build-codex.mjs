// Build the self-contained Codex MCP plugin from the repository's browser core.
//
// Codex snapshots the plugin directory into its cache. The MCP process therefore
// cannot import ../../../lib at runtime, so this build copies the one shared core
// into plugins/codex-moli/dist/lib and copies the adapter alongside it.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const pluginRoot = join(repo, 'plugins', 'codex-moli');
const dist = join(pluginRoot, 'dist');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const manifestPath = join(pluginRoot, 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const compatibilityManifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
const compatibilityManifest = JSON.parse(readFileSync(compatibilityManifestPath, 'utf8'));
const pluginPackage = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));

function ensureInside(parent, child) {
  const pathFromParent = relative(resolve(parent), resolve(child));
  if (pathFromParent === '' || pathFromParent.startsWith(`..${sep}`) || pathFromParent === '..') {
    throw new Error(`refusing to write outside ${parent}: ${child}`);
  }
}

ensureInside(pluginRoot, dist);
if (manifest.version !== pkg.version) {
  throw new Error(`plugin.json version ${String(manifest.version)} does not match package.json ${pkg.version}`);
}
if (compatibilityManifest.version !== pkg.version) {
  throw new Error(`.codex-plugin/plugin.json version ${String(compatibilityManifest.version)} does not match package.json ${pkg.version}`);
}
if (pluginPackage.version !== pkg.version) {
  throw new Error(`Codex plugin package version ${String(pluginPackage.version)} does not match package.json ${pkg.version}`);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'lib'), { recursive: true });

for (const file of ['moli.js', 'install.js']) {
  const source = join(repo, 'lib', file);
  if (!existsSync(source)) throw new Error(`missing shared core file: ${source}`);
  copyFileSync(source, join(dist, 'lib', file));
}

const adapterSource = readFileSync(join(pluginRoot, 'src', 'server.mjs'), 'utf8');
const adapter = adapterSource.replaceAll('__MOLI_VERSION__', pkg.version);
if (adapter.includes('__MOLI_VERSION__')) throw new Error('server version placeholder was not replaced');
writeFileSync(join(dist, 'server.mjs'), adapter);

for (const file of ['server.mjs', join('lib', 'moli.js'), join('lib', 'install.js')]) {
  execFileSync(process.execPath, ['--check', join(dist, file)], { stdio: 'inherit' });
}

const relativeImports = [...adapter.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)].map(match => match[1]);
for (const specifier of relativeImports) {
  const target = resolve(dist, specifier);
  ensureInside(dist, target);
  if (!existsSync(target)) throw new Error(`built server imports a missing local module: ${specifier}`);
}

console.log(`Built Codex plugin ${manifest.name}@${pkg.version}`);
console.log(`  ${relative(repo, join(dist, 'server.mjs'))}`);
console.log(`  ${relative(repo, join(dist, 'lib', 'moli.js'))}`);
console.log(`  ${relative(repo, join(dist, 'lib', 'install.js'))}`);
