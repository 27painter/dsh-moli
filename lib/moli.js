/**
 * Moli runner: spawn the local `moli.exe` headless-browser engine and return its
 * output without the two traps this machine hits.
 *
 * Trap 1 — pipe capture. Under DSH's Windows sandbox a child process cannot open
 * inherited named pipes, so `spawnSync(..., { stdio: 'pipe' })` yields status
 * `null` and zero bytes. Output therefore always goes to real files and is read
 * back afterwards.
 *
 * Trap 2 — UTF-16 mangling. PowerShell's `>` operator re-encodes a native
 * program's bytes, so a screenshot written that way grows a `00` after every
 * byte and is no longer a PNG. Bytes are copied verbatim from the file here.
 *
 * @module dsh-moli/lib/moli
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Output formats that are bytes, not text. */
const BINARY_DUMPS = new Set(['screenshot', 'screenshot_full', 'pdf']);

/** Formats that require the layout renderer to produce anything at all. */
const LAYOUT_DUMPS = new Set(['screenshot', 'screenshot_full', 'pdf']);

/** Formats whose output is a self-describing text document. */
const TEXT_DUMPS = new Set([undefined, 'html', 'markdown', 'json', 'semantic_tree', 'semantic_tree_text']);

/** Accepted `--wait` lifecycle stages. */
const WAIT_STAGES = new Set(['domcontentloaded', 'load', 'networkidle', 'domstable', 'done']);

/**
 * The exit code the engine uses for "the final main-document status was >= 400".
 * Its help states it for `--fail` and `--fail-with-body`; treating it specially is
 * what lets an HTTP error be reported without discarding the body.
 */
const ENGINE_HTTP_ERROR_STATUS = 22;

/** `scroll` keywords, mapped to what they mean in the page. */
const SCROLL_TOKENS = {
  top: '0',
  bottom: 'document.documentElement.scrollHeight',
};

/**
 * Build the expression that scrolls the page, to be run by the engine's own
 * `--eval` before the dump.
 *
 * Scrolling is not a nicety: a page can load content on its first scroll event, and
 * then a fetch without scrolling sees a placeholder while the same fetch with it
 * sees the content. Verified against a page whose scroll handler fills a slot --
 * the dump carried the loaded text with `scroll` and the placeholder without it.
 * Moli does serialize the whole document either way, so this is not about reaching
 * content that "below the fold" already contains; it is about triggering the
 * handler, the intersection observer, or the lazy image that only runs on a scroll.
 *
 * @param scroll - pixels down (negative scrolls up), or `top` / `bottom`.
 * @returns a JavaScript expression, or undefined when there is nothing to do.
 */
export function scrollScript(scroll) {
  if (scroll === undefined || scroll === null) return undefined;
  let target;
  if (typeof scroll === 'number') {
    if (!Number.isFinite(scroll)) return undefined;
    target = String(Math.trunc(scroll));
  } else if (typeof scroll === 'string') {
    const key = scroll.trim().toLowerCase();
    if (key === '') return undefined;
    target = SCROLL_TOKENS[key] ?? (/^-?\d+$/u.test(key) ? key : undefined);
    if (target === undefined) return undefined;
  } else {
    return undefined;
  }
  // Dispatch a scroll event as well as moving: `window.scrollTo` updates the
  // position, but a page listening for the event is the reason this exists.
  return `(() => { window.scrollTo(0, ${target}); window.dispatchEvent(new Event('scroll')); return String(window.scrollY); })()`;
}

/**
 * Combine the caller's `eval` with a scroll, if one was asked for.
 *
 * The two have to share one expression because the engine accepts a single
 * `--eval`. The scroll goes first so the page is in its final state before the
 * caller's expression reads it, and the caller's value still becomes the result.
 *
 * @returns the expression to pass, or undefined when neither was given.
 */
export function combineEval(evalExpression, scroll) {
  const move = scrollScript(scroll);
  if (move === undefined) return evalExpression;
  if (evalExpression === undefined || evalExpression === '') return move;
  // The caller's expression is kept last and wrapped so its value is the one the
  // engine reports. Losing it would contradict the documented `eval` behaviour.
  return `${move}; (() => (${evalExpression}))()`;
}

/**
 * Every place this plugin will look for `moli.exe`, most explicit first.
 *
 * The recursive `%LOCALAPPDATA%\Moli` entry exists because Moli's installer has
 * placed the binary under versioned subdirectories, so a fixed `bin\moli.exe`
 * path is not enough to find an installation that plainly exists.
 *
 * @param override - explicit path from configuration, when set.
 * @returns candidate paths, in probe order.
 */
export function moliCandidates(override) {
  const isWin = process.platform === 'win32';
  const home = process.env.HOME ?? homedir();
  const listed = [
    override,
    process.env.MOLI_BIN,
    // Windows: official installer location.
    isWin && process.env.LOCALAPPDATA !== undefined ? join(process.env.LOCALAPPDATA, 'Moli', 'bin', 'moli.exe') : undefined,
    isWin && process.env.USERPROFILE !== undefined ? join(process.env.USERPROFILE, '.local', 'bin', 'moli.exe') : undefined,
    // Linux/macOS: installer.sh default ~/.local/bin/moli, plus versioned/shared dirs.
    !isWin ? join(home, '.local', 'bin', 'moli') : undefined,
    !isWin ? join(home, '.local', 'share', 'moli', 'bin', 'moli') : undefined,
    !isWin ? join(home, '.local', 'share', 'moli', 'moli') : undefined,
    !isWin ? join(home, '.moli', 'bin', 'moli') : undefined,
  ].filter(candidate => typeof candidate === 'string' && candidate.length > 0);

  const discovered = [];
  if (isWin) {
    const root = process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Moli');
    if (root !== undefined && existsSync(root)) {
      let entries = [];
      try {
        entries = readdirSync(root, { recursive: true, withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase() === 'moli.exe') {
          discovered.push(join(entry.parentPath ?? root, entry.name));
        }
      }
    }
  } else {
    const seen = new Set(listed);
    for (const dir of String(process.env.PATH ?? '').split(':')) {
      if (dir === '') continue;
      const candidate = join(dir, 'moli');
      if (existsSync(candidate) && !seen.has(candidate)) discovered.push(candidate);
    }
  }
  return [...listed, ...discovered];
}

/**
 * Locate the installed `moli.exe`.
 *
 * @param override - explicit path from configuration, when set.
 * @returns the absolute executable path, or undefined when nothing exists there.
 */
export function findMoli(override) {
  for (const candidate of moliCandidates(override)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Read moli's version banner.
 *
 * @param exe - absolute path to `moli.exe`.
 * @returns the version string, or undefined when the call failed.
 */
export function moliVersion(exe) {
  // Via runOnce, not a pipe: the sandbox blocks inherited-pipe capture, which
  // would report "unknown" even for a perfectly good executable.
  const outcome = runOnce({ exe, args: ['--version'] });
  if (outcome.status !== 0) return undefined;
  const text = outcome.stdout.toString('utf8').trim();
  return text === '' ? undefined : text;
}

/**
 * Normalize a diagnostic blob into one readable line.
 *
 * The engine writes "Error: ...\nReason: ..." to stderr; keep the leading lines
 * and drop control bytes so the message survives a JSON round trip.
 *
 * @param text - raw stderr text.
 * @returns the condensed message.
 */
function condense(text) {
  return String(text)
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/\r/gu, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, 6)
    .join(' | ');
}

/**
 * Decide whether a failure is the sandbox's Schannel block rather than a real
 * network fault, so the caller can say so explicitly instead of guessing.
 *
 * @param message - condensed stderr text.
 * @returns whether the low-integrity TLS restriction caused it.
 */
export function isSandboxTlsFailure(message) {
  return /SEC_E_NO_CREDENTIALS|schannel/iu.test(message);
}

/**
 * Classify a transport failure as "the host never answered".
 *
 * A blocked host fails at connect time (`Failed to connect`, reset, refused) or,
 * when the socket never opens, as a readiness timeout with nothing to show. A
 * readiness timeout can also mean a genuinely slow page, so that weaker case is
 * reported separately as {@link possiblyUnreachable}.
 *
 * @param message - condensed stderr text.
 * @returns whether a connect-time failure was reported, and whether any timeout was.
 */
export function isUnreachableFailure(message) {
  const text = String(message);
  const connectFailure = /Failed to connect|Could not connect|Connection was reset|Connection refused/iu.test(text);
  return {
    unreachable: connectFailure,
    possiblyUnreachable: connectFailure || /Timeout was reached|readiness timed out/iu.test(text),
  };
}

/**
 * Run one `moli` invocation and return its stdout as bytes plus its stderr as text.
 *
 * @param options - executable path, argv, timeout, and optional proxy.
 * @returns the settled outcome; never throws for a non-zero exit.
 */
export function runOnce(options) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-moli-'));
  const outPath = join(dir, 'stdout.bin');
  const errPath = join(dir, 'stderr.txt');
  let outFd;
  let errFd;
  try {
    outFd = openSync(outPath, 'w');
    errFd = openSync(errPath, 'w');
    const spawnArgs = [...options.args];
    if (options.timeoutMs !== undefined) spawnArgs.push('-t', String(options.timeoutMs));
    if (options.proxy !== undefined && options.proxy !== '') {
      spawnArgs.push('--http-proxy', options.proxy);
    }
    const result = spawnSync(options.exe, spawnArgs, {
      stdio: ['ignore', outFd, errFd],
      // Cancellation backstop, not the engine's readiness deadline: it must sit
      // above the `-t` value handed to moli, or the process is killed before it
      // can report its own timeout.
      timeout: options.spawnTimeoutMs ?? (options.timeoutMs === undefined ? 60000 : options.timeoutMs + 30000),
      windowsHide: true,
    });
    closeSync(outFd);
    outFd = undefined;
    closeSync(errFd);
    errFd = undefined;

    const stdout = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    const stderrText = existsSync(errPath) ? readFileSync(errPath, 'utf8') : '';
    const failed = result.error !== undefined && result.error !== null;
    return {
      status: failed ? null : (result.status ?? 0),
      stdout,
      stderr: condense(stderrText),
      spawnError: failed ? `${result.error.code ?? 'spawn failed'}: ${result.error.message}` : undefined,
    };
  } finally {
    if (outFd !== undefined) closeSync(outFd);
    if (errFd !== undefined) closeSync(errFd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run one `moli fetch` and return its stdout as bytes plus its stderr as text.
 *
 * The timeout is spliced in *before* the caller's options. Appending it would
 * place `-t <ms>` after a trailing `--eval <expression>`, whose option there
 * swallows the value — so `moli … --eval "1+1" -t 30000` would evaluate the
 * timeout instead of the expression.
 *
 * @param options - executable path, argv tail, timeout, and optional proxy.
 * @returns the settled outcome; never throws for a non-zero exit.
 */
export function fetchOnce(options) {
  const prelude = options.timeoutMs === undefined ? [] : ['-t', String(options.timeoutMs)];
  const argv = options.args.length > 0 && options.args[0] === 'fetch'
    ? [options.args[0], ...prelude, ...options.args.slice(1)]
    : [...options.args, ...prelude];
  return runOnce({
    ...options,
    args: argv,
    timeoutMs: undefined,
    spawnTimeoutMs: options.timeoutMs === undefined ? undefined : options.timeoutMs + 30000,
  });
}

/**
 * Translate one tool argument set into the engine's argv.
 *
 * @param args - validated tool arguments.
 * @returns the argv tail (everything after the executable).
 */
/**
 * Build the `moli fetch` argument vector for one call.
 *
 * Exported so the mapping from tool parameters to engine flags can be asserted
 * directly. That matters more than it sounds: a parameter that silently fails to
 * reach the engine is indistinguishable from a feature that does not work, and the
 * only fast, deterministic way to tell them apart is to check the vector.
 *
 * @param args - tool arguments.
 * @returns the argv tail (without the executable).
 */
export function buildArgs(args) {
  if (args.dump !== undefined && !TEXT_DUMPS.has(args.dump) && !BINARY_DUMPS.has(args.dump)) {
    throw new Error(`unsupported dump: ${String(args.dump)}`);
  }
  if (args.wait !== undefined && args.wait !== '' && !WAIT_STAGES.has(args.wait)) {
    throw new Error(`unsupported wait stage: ${String(args.wait)}`);
  }
  const needsLayout = LAYOUT_DUMPS.has(args.dump) || args.layout === true || args.scrollbars === true;
  const argv = ['fetch', args.url];

  if (args.dump !== undefined) argv.push('-d', args.dump);
  // Screenshots and PDFs silently produce nothing without the layout renderer.
  if (needsLayout) argv.push('--layout');
  if (args.scrollbars === true) argv.push('--scrollbars');
  // `scroll` rides along in the same expression: the engine takes a single `--eval`,
  // and the scroll has to happen before the page is captured.
  const evaluation = combineEval(args.eval, args.scroll);
  if (evaluation !== undefined) argv.push('--eval', evaluation);
  if (args.wait !== undefined && args.wait !== '') argv.push('--wait', args.wait);
  if (args.waitSelector !== undefined && args.waitSelector !== '') argv.push('--wait-selector', args.waitSelector);
  if (args.waitScript !== undefined && args.waitScript !== '') argv.push('--wait-script', args.waitScript);
  // Response waits: the right way to await an AJAX list, where a fixed delay is a
  // guess. The engine takes one of each, and a caller supplying several is asking
  // for "any of these", which is the engine's own semantics for multiple waits.
  if (args.waitResponseUrl !== undefined && args.waitResponseUrl !== '') argv.push('--wait-response-url', args.waitResponseUrl);
  if (args.waitResponseJson !== undefined && args.waitResponseJson !== '') argv.push('--wait-response-json', args.waitResponseJson);
  // The engine's own switch, but only when the caller asked for a failure to be
  // surfaced: adding it unconditionally would turn every 404 into `ok: false` and
  // change what existing calls do.
  if (args.failOnHttpError === true) argv.push('--fail-with-body');
  if (args.delayMs !== undefined) argv.push('--delay-ms', String(args.delayMs));
  if (args.noJs === true) argv.push('--disable-js');
  if (args.noCss === true) argv.push('--disable-css');
  if (args.resources === true) argv.push('--resource');
  if (args.withFrames === true) argv.push('--with-frames');
  if (args.insecureTls === true) argv.push('--insecure-disable-tls-host-verification');
  if (args.userAgent !== undefined && args.userAgent !== '') argv.push('--user-agent', args.userAgent);
  if (args.profileDir !== undefined && args.profileDir !== '') argv.push('--profile-dir', args.profileDir);
  if (args.cookieFile !== undefined && args.cookieFile !== '') argv.push('--cookie-file', args.cookieFile);
  if (Array.isArray(args.headers)) {
    for (const header of args.headers) argv.push('-H', header);
  }
  return argv;
}

/**
 * Execute one `moli fetch` request and materialize its result.
 *
 * Ordinary failures come back as `ok: false` values so the model can react; only
 * a malformed request throws.
 *
 * @param options - resolved executable, validated arguments, and output policy.
 * @returns the canonical tool value.
 */
export function runFetch(options) {
  // The configured no-verify default applies only when the call stays silent;
  // an explicit false still means "verify fully".
  const args = options.insecureTls === true && options.args.insecureTls === undefined
    ? { ...options.args, insecureTls: true }
    : options.args;
  const argv = buildArgs(args);
  const timeoutMs = args.timeoutMs ?? 30000;
  const isBinary = BINARY_DUMPS.has(args.dump);

  // Reject a byte-returning dump with nowhere to put it before spending a fetch.
  if (isBinary && (args.writeTo === undefined || args.writeTo === '')) {
    return {
      ok: false,
      url: args.url,
      error: `dump "${String(args.dump)}" produces bytes and cannot be returned as text`,
      sandboxTlsBlock: false,
      hint: `Pass writeTo with an absolute .${args.dump === 'pdf' ? 'pdf' : 'png'} path, then read that file.`,
    };
  }

  const outcome = fetchOnce({
    exe: options.exe,
    args: argv,
    timeoutMs,
    proxy: options.proxy,
  });

  const bytes = outcome.stdout.length;
  const stderr = outcome.spawnError === undefined ? outcome.stderr : `${outcome.spawnError} | ${outcome.stderr}`;

  // Empty stdout on a zero exit is not a failure: a page can legitimately have
  // no content in the requested format, which is exactly what a client-rendered
  // page yields under `noJs` with a text dump. moli is right to print nothing
  // for it, and the old code answered with "moli exited with status 0 and no
  // output" plus a hint to re-check the install, sending the caller after a host
  // that was never broken.
  //
  // Both decisions live in this one branch on purpose. Splitting them -- empty
  // stdout treated as success here and stderr checked further down -- lets the
  // case below (silent stdout, a complaint on stderr, exit 0) fall through to
  // the normal success path with the complaint silently dropped.
  if (outcome.status === 0 && bytes === 0) {
    if (stderr !== '') {
      return {
        ok: false,
        url: args.url,
        error: stderr,
        sandboxTlsBlock: isSandboxTlsFailure(stderr),
        unreachable: false,
        possiblyUnreachable: false,
        hint: 'The engine exited cleanly but produced no output and explained why on stderr; the text above is its own message.',
      };
    }
    return {
      ok: true,
      url: args.url,
      kind: 'text',
      dump: args.dump ?? 'html',
      content: '',
      chars: 0,
      bytes: 0,
      empty: true,
      note: 'moli succeeded and produced no output, so the page had no content in this format. '
        + 'A page whose content is built by JavaScript yields nothing when noJs is set; '
        + 'the same URL renders normally without it.',
    };
  }

  // The engine signals an HTTP error with exit code 22 and, under
  // `--fail-with-body`, keeps whatever the output format produced. That is why the
  // body is still here: the caller is told the fetch failed *and* gets to read what
  // came back, which is what an error page is for.
  //
  // This branch is reached for binary dumps too -- a screenshot of an error page is
  // still a screenshot -- so it must not decode stdout as text.
  if (outcome.status === ENGINE_HTTP_ERROR_STATUS && bytes > 0) {
    // The status is in the stderr reason. A JSON dump also carries it in the body,
    // which is the fallback when the reason wording changes.
    const reported = httpStatusFrom(stderr);
    if (isBinary) {
      const failure = ensureWritable(args.writeTo);
      if (failure !== undefined) {
        return { ok: false, url: args.url, httpError: true, error: failure, hint: 'Pass an absolute path in an existing directory.' };
      }
      writeFileSync(args.writeTo, outcome.stdout);
      return {
        ok: false,
        url: args.url,
        kind: 'binary',
        dump: args.dump,
        path: args.writeTo,
        bytes,
        httpError: true,
        ...(reported === undefined ? {} : { status: reported }),
        error: stderr.trim() === '' ? 'the server answered with an HTTP error status' : stderr.trim(),
        hint: `The image the server returned was written to ${String(args.writeTo)}. Drop \`failOnHttpError\` to treat this as ordinary output.`,
      };
    }
    const text = outcome.stdout.toString('utf8');
    const status = reported
      ?? (args.dump === 'json' && text.trimStart().startsWith('{') ? parseStatus(text) : undefined);
    return {
      ok: false,
      url: args.url,
      httpError: true,
      ...(status === undefined ? {} : { status }),
      error: stderr.trim() === ''
        ? `the server answered with an HTTP error status${status === undefined ? '' : ` (${String(status)})`}`
        : stderr.trim(),
      content: text,
      chars: text.length,
      hint: 'The request reached a server and it refused. The content above is the error page as the engine rendered it, '
        + 'so it is often worth reading. Drop `failOnHttpError` to treat this as ordinary content instead.',
    };
  }

  if (outcome.status !== 0) {
    const sandboxTls = isSandboxTlsFailure(stderr);
    // A blocked host fails at connect time ("Failed to connect" / RST) or, when
    // the socket never opens, as a readiness timeout with nothing to show. A
    // readiness timeout can also mean a genuinely slow page, so it is reported
    // as *possibly* unreachable and worded as a suggestion rather than a verdict.
    const { unreachable, possiblyUnreachable } = isUnreachableFailure(stderr);
    // The engine reports a thrown expression as
    //   `Reason: JavaScript evaluation failed: TypeError: ... at <anonymous>:1:6`
    // which is a bug in the call, not an install or network problem. Falling
    // through to the generic hint below used to tell the caller to re-check the
    // installation with moli_probe, which cannot possibly help.
    const evalFailure = args.eval !== undefined && /JavaScript evaluation failed/u.test(stderr);
    // A binary dump that failed produced no file at all. Saying only "exited with
    // status 1" leaves the caller to guess whether an image exists; the useful fact
    // is that it does not, and that a text dump would have captured this page.
    const binaryFailure = isBinary && httpStatusFrom(stderr) !== undefined;
    const hint = evalFailure
      ? 'The eval expression threw. Check that the page has reached the state you expect (`wait` or `waitSelector`), that the selector matches an element, and that the expression is valid JavaScript. The engine error names the type and position.'
      : binaryFailure
        ? 'The engine could not render this page, so no file was written. An HTTP error still produces a body for a text dump (markdown, html or json), so ask for one of those if you need to see what the server returned.'
        : sandboxTls
          ? 'The DSH file sandbox blocks Schannel client credentials, so moli cannot do TLS at low integrity. Retry the same call with sandbox_permissions "danger-full-access" (with a justification), use an http:// URL, or pass proxy to reach a local forward proxy.'
          : possiblyUnreachable
            ? 'The host did not answer in time. Reachability to some hosts varies on this network, so retrying may succeed; if a local forward proxy is available, setting the plugin config field `proxy` is the other option. A certificate problem would report a schannel error instead of a timeout.'
            : 'Run moli_probe to confirm the install, then retry; use waitSelector or eval for a page that renders late.';
    const failureStatus = httpStatusFrom(stderr);
    return {
      ok: false,
      url: args.url,
      ...(failureStatus === undefined ? {} : { status: failureStatus, httpError: true }),
      error: stderr === '' ? `moli exited with status ${String(outcome.status)} and no output` : stderr,
      sandboxTlsBlock: sandboxTls,
      unreachable,
      possiblyUnreachable,
      ...(evalFailure ? { evalFailed: true } : {}),
      hint,
    };
  }

  if (isBinary) {
    const failure = ensureWritable(args.writeTo);
    if (failure !== undefined) {
      return { ok: false, url: args.url, error: failure, sandboxTlsBlock: false, hint: 'Pass an absolute path in an existing directory.' };
    }
    // A binary dump produces nothing for an HTTP error: the engine exits 1 before
    // rendering anything, unlike the text dumps which exit 22 with the body kept.
    // Nothing is written, so say that rather than leaving an empty file behind.
    if (outcome.status !== 0) {
      const status = httpStatusFrom(stderr);
      return {
        ok: false,
        url: args.url,
        ...(status === undefined ? {} : { status }),
        httpError: outcome.status === ENGINE_HTTP_ERROR_STATUS || status !== undefined,
        error: stderr.trim() === '' ? `moli exited with status ${String(outcome.status)} before producing ${String(args.dump)} output` : stderr.trim(),
        hint: 'The engine could not render this page, so no file was written. A text dump (markdown, html or json) still captures an HTTP error body; binary output does not.',
      };
    }
    writeFileSync(args.writeTo, outcome.stdout);
    return {
      ok: true,
      url: args.url,
      kind: 'binary',
      dump: args.dump,
      path: args.writeTo,
      bytes,
      note: 'Binary output was written verbatim; read the file instead of asking moli to print it.',
    };
  }

  const text = outcome.stdout.toString('utf8');
  // A JSON dump is the only format that reports the HTTP status, so an error
  // page is otherwise indistinguishable from content. Surface it rather than
  // letting the model read a 404 body as if the fetch succeeded.
  const httpStatus = args.dump === 'json' && text.trimStart().startsWith('{')
    ? parseStatus(text)
    : undefined;
  if (typeof httpStatus === 'number' && httpStatus >= 400) {
    return {
      ok: false,
      url: args.url,
      status: httpStatus,
      error: `the server answered HTTP ${String(httpStatus)}`,
      sandboxTlsBlock: false,
      hint: 'The request reached the server; the URL or credentials are the problem, not the network.',
    };
  }
  if (args.writeTo !== undefined && args.writeTo !== '') {
    const failure = ensureWritable(args.writeTo);
    if (failure !== undefined) {
      return { ok: false, url: args.url, error: failure, sandboxTlsBlock: false, hint: 'Pass an absolute path in an existing directory.' };
    }
    writeFileSync(args.writeTo, outcome.stdout);
    return {
      ok: true,
      url: args.url,
      kind: 'text',
      dump: args.dump ?? 'html',
      path: args.writeTo,
      chars: text.length,
      bytes,
      note: 'Full output saved to file; read it for the complete text.',
    };
  }

  const limit = args.maxChars ?? options.maxChars;
  const truncated = typeof limit === 'number' && limit > 0 && text.length > limit;
  // Keep the head and the tail rather than only the head. For a rendered page the
  // head is chrome -- a nav bar, a consent banner, dozens of image placeholders --
  // so a head-only slice can return 200,000 characters of navigation and none of
  // the content the caller asked for. Splitting the budget keeps whatever the page
  // ends with, and the note says exactly what went missing so the caller can decide
  // whether to re-fetch with writeTo.
  let content = text;
  let note;
  let omitted;
  if (truncated) {
    // Reserve room for the marker, but never let it swallow a small budget.
    const reserve = Math.min(240, Math.floor(limit / 8));
    const budget = Math.max(2, limit - reserve);
    const headLen = Math.ceil(budget * 0.6);
    const tailLen = budget - headLen;
    omitted = text.length - budget;
    const mark = `\n\n… [dsh-moli] ${String(omitted)} characters omitted here; the head and tail are kept. Pass writeTo to keep all ${String(text.length)}. …\n\n`;
    content = text.slice(0, headLen) + mark + text.slice(text.length - tailLen);
    note = `Output truncated: showing the first ${String(headLen)} and the last ${String(tailLen)} of ${String(text.length)} characters, with ${String(omitted)} omitted in the middle. Pass writeTo to keep all ${String(text.length)}.`;
  }
  return {
    ok: true,
    url: args.url,
    kind: 'text',
    dump: args.dump ?? 'html',
    content,
    chars: text.length,
    bytes,
    truncated,
    ...(truncated ? { omitted, note } : {}),
  };
}

/**
 * Read the HTTP status out of the engine's stderr reason.
 *
 * The engine reports it there, in the form
 *   `Reason: final main document returned HTTP status 404 at ...`
 * for `--fail` and `--fail-with-body`, whatever the dump format. That makes stderr
 * the reliable source: a JSON dump also carries the status in its body, but a
 * markdown or HTML dump does not, and this branch has to name the status for those
 * too. Matching narrowly keeps an unrelated number in the text from being read as a
 * status.
 *
 * @param stderr - the engine's stderr text.
 * @returns the numeric status, or undefined when it is not reported.
 */
function httpStatusFrom(stderr) {
  const match = /HTTP status (\d{3})\b/u.exec(String(stderr));
  return match === null ? undefined : Number(match[1]);
}

/**
 * Read the HTTP status out of a JSON dump without trusting its shape.
 *
 * @param text - the dump's JSON text.
 * @returns the numeric status, or undefined when it is absent or not a number.
 */
function parseStatus(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.status === 'number' ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check that an output path can be created before the engine runs.
 *
 * @param path - requested destination path.
 * @returns an error message, or undefined when the path looks usable.
 */
function ensureWritable(path) {
  const parent = dirname(path);
  if (!existsSync(parent)) return `destination directory does not exist: ${parent}`;
  if (existsSync(path) && !statIsFile(path)) return `destination is not a regular file: ${path}`;
  return undefined;
}

/**
 * Whether a path exists as a regular file.
 *
 * @param path - candidate path.
 * @returns whether it is a file.
 */
function statIsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Report whether the engine exists and can reach HTTPS from this process.
 *
 * @param exe - absolute path to `moli.exe`.
 * @param probeUrl - an HTTPS URL to fetch in text mode.
 * @returns the diagnostic value.
 */
export function probe(exe, probeUrl, insecureTls = false) {
  const version = moliVersion(exe);
  const probeArgs = ['fetch', probeUrl, '-d', 'markdown'];
  if (insecureTls) probeArgs.push('--insecure-disable-tls-host-verification');
  const outcome = fetchOnce({ exe, args: probeArgs, timeoutMs: 20000 });
  const stderr = outcome.spawnError === undefined ? outcome.stderr : `${outcome.spawnError} | ${outcome.stderr}`;
  // A zero exit means moli reached the host and fetched it. Requiring non-empty
  // stdout as well would report httpsOk:false for a page that simply has no
  // text — a probe URL is not guaranteed to carry content, and the field is
  // documented as "can reach HTTPS", which is what the exit status proves.
  const ok = outcome.status === 0;
  const revocation = /CRYPT_E_REVOCATION_OFFLINE|revocation/iu.test(stderr);
  return {
    exe,
    version: version ?? 'unknown',
    // `httpsOk` describes the process that ran this call, which for the plugin is
    // the DSH host. It says nothing about whether a separate restricted shell can
    // reach the network -- under the file sandbox that shell fails on TLS while
    // this path succeeds, so the scope is stated rather than implied.
    httpsOkScope: 'the process that ran this probe (the DSH host process when called through moli_probe), not any other shell on this machine',
    httpsOk: ok,
    probeUrl,
    detail: ok
      ? (outcome.stdout.length > 0
        ? 'HTTPS fetch succeeded from the DSH host process.'
        : 'HTTPS fetch succeeded from the DSH host process (the probe URL returned no text).')
      : revocation && !insecureTls
        ? `${stderr} | This is a certificate-revocation check failing (offline CRL/OCSP responder); retrying with the no-verify flag normally clears it.`
        : stderr,
    sandboxTlsBlock: isSandboxTlsFailure(stderr),
    revocationBlock: revocation,
  };
}
