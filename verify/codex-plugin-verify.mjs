// Offline contract and stdio handshake checks for the Codex plugin.
//
// The MCP page fetch uses a data: URL, so the end-to-end half does not require
// network access. It skips only when no Moli engine is installed.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const pluginRoot = join(repo, 'plugins', 'codex-moli');
const dist = join(pluginRoot, 'dist');

let pass = 0;
let fail = 0;
let skip = 0;
const check = (label, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS ${label}${extra ? ` -- ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${extra ? ` -- ${extra}` : ''}`);
  }
};
const skipped = (label, reason) => {
  skip++;
  console.log(`  SKIP ${label} -- ${reason}`);
};

console.log('1. package and marketplace manifests');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
const compatibilityManifest = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const pluginPackage = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8'));
const marketplace = JSON.parse(readFileSync(join(repo, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
check('plugin version matches package version', manifest.version === pkg.version, `${manifest.version}`);
check('compatibility manifest version matches package version', compatibilityManifest.version === pkg.version, `${compatibilityManifest.version}`);
check('plugin package version matches package version', pluginPackage.version === pkg.version, `${pluginPackage.version}`);
check('plugin name is stable', manifest.name === 'moli');
check('compatibility manifest uses the same name', compatibilityManifest.name === 'moli');
check('compatibility manifest references skills', compatibilityManifest.skills === './skills/');
check('compatibility manifest references the MCP configuration', compatibilityManifest.mcpServers === './mcp.json');
check('repository has a security policy', existsSync(join(repo, 'SECURITY.md')));
check('plugin package has a security policy', existsSync(join(pluginRoot, 'SECURITY.md')));
check('plugin package has a license', existsSync(join(pluginRoot, 'LICENSE')));
check('plugin package has third-party notices', existsSync(join(pluginRoot, 'THIRD-PARTY-NOTICES.md')));
check('plugin package has a lockfile', existsSync(join(pluginRoot, 'package-lock.json')));
check('repository has Dependabot configuration', existsSync(join(repo, '.github', 'dependabot.yml')));
check('repository has a HOL scanner workflow', existsSync(join(repo, '.github', 'workflows', 'hol-plugin-scanner.yml')));
const workflows = readdirSync(join(repo, '.github', 'workflows')).filter(file => /\.ya?ml$/u.test(file));
const unpinned = workflows.flatMap(file => {
  const text = readFileSync(join(repo, '.github', 'workflows', file), 'utf8');
  return [...text.matchAll(/uses:\s+([^\s#]+)/gu)]
    .map(match => ({ file, use: match[1] }))
    .filter(entry => !/@[0-9a-f]{40}$/u.test(entry.use));
});
check('all workflow actions are SHA-pinned', unpinned.length === 0, unpinned.map(entry => `${entry.file}:${entry.use}`).join(', '));
check('marketplace contains the plugin', marketplace.plugins?.some(entry => entry.name === 'moli'));
check('marketplace uses the plugin subdirectory', marketplace.plugins?.some(entry => entry.source?.path === './plugins/codex-moli'));
check('MCP server is local stdio', mcp.mcpServers?.moli?.type === 'stdio');
check('MCP launcher uses PLUGIN_ROOT', mcp.mcpServers?.moli?.args?.[0]?.includes('${PLUGIN_ROOT}'));

console.log('\n2. build output is self-contained');
for (const file of ['server.mjs', join('lib', 'moli.js'), join('lib', 'install.js')]) {
  check(`dist includes ${file}`, existsSync(join(dist, file)));
}
const logo = readFileSync(join(pluginRoot, 'assets', 'logo.svg'), 'utf8');
check('listing icon declares 512x512 dimensions', /<svg[^>]*\bwidth="512"[^>]*\bheight="512"/u.test(logo));
const serverText = readFileSync(join(dist, 'server.mjs'), 'utf8');
check('build replaced the version placeholder', !serverText.includes('__MOLI_VERSION__'));
check('dist imports only local modules', !/from\s+['"]\.\.\//u.test(serverText));
for (const file of ['moli.js', 'install.js']) {
  const source = readFileSync(join(repo, 'lib', file));
  const built = readFileSync(join(dist, 'lib', file));
  check(`dist core is current: ${file}`, source.equals(built), 'run npm run build:codex');
}
const expectedServer = readFileSync(join(pluginRoot, 'src', 'server.mjs'), 'utf8').replaceAll('__MOLI_VERSION__', pkg.version);
check('dist adapter is current', serverText === expectedServer, 'run npm run build:codex');

const { findMoli } = await import(pathToFileURL(join(repo, 'lib', 'moli.js')).href);
const exe = findMoli();

console.log('\n3. MCP stdio handshake and tool catalog');
const verifyLiveSearch = process.env.MOLI_VERIFY_SEARCH === '1';
const fixtureEmptySearchUrl = `data:text/html,${encodeURIComponent(
  '<html><body><span>{query}</span><p>No results fixture</p></body></html>',
)}`;
const fixtureSearchUrl = `data:text/html,${encodeURIComponent(
  '<html><body><span>{query}</span><li class="b_algo"><h2><a href="https://example.com/result">Example Result</a></h2><p>Example snippet</p></li></body></html>',
)}`;
const child = spawn(process.execPath, [join(dist, 'server.mjs')], {
  cwd: pluginRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: {
    ...process.env,
    ...(verifyLiveSearch ? {} : { MOLI_SEARCH_URLS: `${fixtureEmptySearchUrl}|${fixtureSearchUrl}` }),
  },
});
let stdout = '';
let stderr = '';
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  stdout += chunk;
  while (true) {
    const newline = stdout.indexOf('\n');
    if (newline < 0) break;
    const line = stdout.slice(0, newline).replace(/\r$/u, '');
    stdout = stdout.slice(newline + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderr += chunk;
});
child.on('exit', code => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`MCP server exited ${String(code)}: ${stderr}`));
  }
  pending.clear();
});

function request(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: message => {
        clearTimeout(timer);
        resolve(message);
      },
      reject: error => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'codex-plugin-verify', version: '1.0.0' },
  });
  check('initialize succeeds', init.result?.serverInfo?.name === 'moli');
  check('initialize advertises tools', init.result?.capabilities?.tools !== undefined);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const listed = await request('tools/list', {});
  const tools = listed.result?.tools ?? [];
  for (const name of ['moli_search', 'moli_fetch', 'moli_capture', 'moli_probe']) {
    check(`tools/list includes ${name}`, tools.some(tool => tool.name === name));
  }
  const search = tools.find(tool => tool.name === 'moli_search');
  check('search requires only a query', JSON.stringify(search?.inputSchema?.required) === JSON.stringify(['query']));
  check('search is read-only and open-world', search?.annotations?.readOnlyHint === true && search?.annotations?.openWorldHint === true);

  if (exe === undefined) {
    skipped('moli_fetch data URL', 'no Moli engine installed');
  } else {
    const fetched = await request('tools/call', {
      name: 'moli_fetch',
      arguments: {
        url: 'data:text/html,<html><body><h1>moli codex ok</h1></body></html>',
        dump: 'markdown',
      },
    }, 60000);
    const value = fetched.result?.structuredContent;
    check('moli_fetch executes through the MCP adapter', value?.ok === true, String(value?.error ?? ''));
    check('moli_fetch returned rendered content', String(value?.content ?? '').includes('moli codex ok'));

    const probed = await request('tools/call', {
      name: 'moli_probe',
      arguments: {},
    }, 30000);
    const probeValue = probed.result?.structuredContent;
    check('moli_probe reports the installed engine', probeValue?.installed === true && probeValue?.ok === true, String(probeValue?.version ?? ''));

    const work = mkdtempSync(join(tmpdir(), 'codex-moli-verify-'));
    const image = join(work, 'capture.png');
    try {
      const captured = await request('tools/call', {
        name: 'moli_capture',
        arguments: {
          url: 'data:text/html,<html><body style="background:#fff"><h1>moli capture ok</h1></body></html>',
          dump: 'screenshot',
          writeTo: image,
        },
      }, 60000);
      const captureValue = captured.result?.structuredContent;
      check('moli_capture executes through the MCP adapter', captureValue?.ok === true, String(captureValue?.error ?? ''));
      check('moli_capture writes a PNG', existsSync(image) && readFileSync(image).subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  if (!verifyLiveSearch) {
    const searched = await request('tools/call', {
      name: 'moli_search',
      arguments: { query: 'offline fixture', limit: 5 },
    }, 60000);
    const value = searched.result?.structuredContent;
    check('moli_search falls back after an empty provider', value?.ok === true && value?.attempts?.length === 2, String(value?.error ?? ''));
    check('moli_search returns a structured result', value?.results?.[0]?.title === 'Example Result' && value?.results?.[0]?.url === 'https://example.com/result');
  } else {
    const searched = await request('tools/call', {
      name: 'moli_search',
      arguments: { query: 'OpenAI Codex', limit: 5 },
    }, 60000);
    const value = searched.result?.structuredContent;
    check('moli_search succeeds', value?.ok === true, String(value?.error ?? ''));
    if (value?.ok === true) check('moli_search found at least one result', value.count > 0, `count=${String(value.count)}`);
  }
} finally {
  child.stdin.end();
  child.kill();
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail > 0) process.exitCode = 1;
