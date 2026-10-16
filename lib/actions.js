/**
 * The actions a session can perform.
 *
 * Kept apart from {@link ./session.js} so the transport (server lifecycle, CDP
 * plumbing) and the behaviour (what `click` means) can be read and tested
 * separately. Every action takes the CDP connection and returns a plain value;
 * none of them throws for a page-level problem, because "that selector matched
 * nothing" is a result the caller has to see, not a transport failure.
 *
 * Selector handling is deliberately uniform: an element is located by CSS
 * selector in the page, measured, and then driven through real input events. The
 * alternative -- taking viewport coordinates from the caller -- makes the model
 * guess pixels, and the coordinates go stale the moment the page reflows.
 *
 * @module dsh-moli/lib/actions
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** CSS-selector quoting, so a selector can be embedded in an expression safely. */
const quote = value => JSON.stringify(String(value));

/**
 * Resolve a selector to a click point, honouring the backend's geometry frame.
 *
 * Two frames exist and they are not interchangeable. Moli's rectangle is
 * document-absolute and does not follow the scroll, and its hit test stops
 * answering past the viewport height; a real Chromium reports a viewport-relative
 * rectangle that a scroll changes. The same measurement code cannot serve both --
 * a bounds test that is right for one silently rejects the other -- so the frame
 * arrives from the session and the two branches below implement it directly.
 *
 * @param geometry - `viewport` (standard) or `absolute` (moli).
 * @returns `{ box, point, tag, text, covered }` on success, `{ error }` otherwise.
 */
async function boxOf(connection, selector, geometry) {
  if (geometry === 'absolute') return boxOfAbsolute(connection, selector);
  return boxOfViewport(connection, selector);
}

/**
 * Moli's frame: the coordinate the engine's input accepts is the one its own
 * rectangle reports, and scrolling changes neither. Measured on moli 1.1.16.
 */
async function boxOfAbsolute(connection, selector) {
  const expression = `(() => {
    const el = document.querySelector(${quote(selector)});
    if (el === null) return { missing: true };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const found = document.elementFromPoint(cx, cy);
    const hitSelf = found !== null && (found === el || el.contains(found) || found.contains(el));
    return {
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: hitSelf ? { x: cx, y: cy } : null,
      covered: hitSelf || found === null ? null : found.tagName.toLowerCase() + (found.id ? '#' + found.id : ''),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
      viewportHeight: innerHeight,
    };
  })()`;
  const result = await connection.evaluate(expression);
  if (result.throws !== undefined) return { error: result.throws };
  const value = result.value;
  if (value === undefined) return { error: 'the page returned nothing for that selector' };
  if (value.missing === true) return { error: `no element matches ${JSON.stringify(selector)}` };
  return value;
}

/**
 * The standards-compliant frame: scroll the element into view, then read the
 * rectangle, which is now viewport-relative. The scroll has to happen *inside* the
 * same evaluation as the measurement, or the rectangle read afterwards describes
 * the pre-scroll layout.
 */
async function boxOfViewport(connection, selector) {
  const expression = `(() => {
    const el = document.querySelector(${quote(selector)});
    if (el === null) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const inside = cx >= 0 && cx <= innerWidth && cy >= 0 && cy <= innerHeight;
    let found = null;
    if (inside) found = document.elementFromPoint(cx, cy);
    const hitSelf = found !== null && (found === el || el.contains(found) || found.contains(el));
    return {
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: hitSelf && inside ? { x: cx, y: cy } : null,
      covered: hitSelf ? null : (found === null ? null : found.tagName.toLowerCase() + (found.id ? '#' + found.id : '')),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
      inViewport: inside,
      viewportHeight: innerHeight,
    };
  })()`;
  const result = await connection.evaluate(expression);
  if (result.throws !== undefined) return { error: result.throws };
  const value = result.value;
  if (value === undefined) return { error: 'the page returned nothing for that selector' };
  if (value.missing === true) return { error: `no element matches ${JSON.stringify(selector)}` };
  return value;
}

/**
 * Measure a selector, in whichever frame the backend uses.
 *
 * The scroll for the standard frame happens inside the measurement expression, so
 * there is nothing to wait for here. A timer would be wrong anyway:
 * `requestAnimationFrame` does not fire while the page is not painting, so a
 * promise waiting on one never settles.
 */
async function ensureVisible(connection, selector, geometry) {
  return boxOf(connection, selector, geometry);
}

/**
 * Turn a measurement into a click that is known to land on the element.
 *
 * A click outside the viewport, or one whose point is covered by another element,
 * is reported rather than dispatched: dispatching anyway produces a silent no-op
 * that looks like success to the caller.
 */
async function clickSelector(connection, selector, geometry) {
  const found = await ensureVisible(connection, selector, geometry);
  if (found.error !== undefined) return { ok: false, error: found.error };
  if (found.visible !== true) return { ok: false, error: `${JSON.stringify(selector)} is not visible (display:none or visibility:hidden)` };
  if (found.point === null) {
    // Only the moli frame has the viewport-height wall. In the standard frame a
    // null point means the element could not be brought on screen, or something
    // is on top of it.
    const beyondViewport = geometry === 'absolute'
      && found.box.y + found.box.height / 2 > (found.viewportHeight ?? 0);
    return {
      ok: false,
      selector,
      error: found.covered !== null
        ? `${JSON.stringify(selector)} is covered by another element (${found.covered})`
        : beyondViewport
          ? `${JSON.stringify(selector)} is below the viewport (y=${String(Math.round(found.box.y))}) and this engine cannot send input there`
          : `${JSON.stringify(selector)} could not be brought into the viewport`,
      hint: found.covered !== null
        ? 'Something is on top of it -- commonly a consent banner or a modal. Dismiss that first, or press Escape.'
        : beyondViewport
          ? 'Moli\'s hit test is bounded by the viewport height and its element geometry does not follow scrolling, so synthetic clicks cannot reach elements further down the document. Use eval to click it in the page instead -- for example `document.querySelector("SEL").click()` -- which bypasses the input layer entirely. Switching the plugin config to `browser: "chromium"` also removes the limit, since a real browser reports standard geometry.'
          : 'The element may be inside a scrollable container, or hidden behind a fixed overlay.',
    };
  }
  await clickAt(connection, found.point.x, found.point.y);
  return { ok: true, found, x: found.point.x, y: found.point.y };
}

/** Dispatch a full click: move, press, release. Real events, so page handlers run. */
async function clickAt(connection, x, y, { clickCount = 1 } = {}) {
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount });
  await connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount });
}

/**
 * Wait until the page has no pending load and the document is unchanged for a
 * short settle window. Used after navigation and after clicks that may navigate.
 */
async function settle(connection, { quietMs = 250, timeoutMs = 20000 } = {}) {
  const started = Date.now();
  let lastSignature;
  let stableSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await connection.evaluate('document.readyState + "|" + document.title + "|" + location.href');
    const signature = String(result.value);
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return { settled: true, ms: Date.now() - started };
    }
    await sleep(100);
  }
  return { settled: false, ms: Date.now() - started };
}

/** A readable, size-bounded view of the rendered page. */
async function snapshot(connection, { maxChars, includeHtml }) {
  const expression = `(() => {
    const text = document.body === null ? '' : document.body.innerText.trim();
    const links = [...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href }));
    return JSON.stringify({
      url: location.href,
      title: document.title,
      text,
      links,
      forms: [...document.querySelectorAll('input,textarea,select')].slice(0, 50).map(el => ({
        tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '',
      })),
      html: ${includeHtml === true ? 'document.documentElement.outerHTML' : "''"},
    });
  })()`;
  const result = await connection.evaluate(expression);
  if (result.throws !== undefined) return { ok: false, error: result.throws };
  const data = JSON.parse(String(result.value));
  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 200000;
  const truncated = data.text.length > limit;
  return {
    ok: true,
    url: data.url,
    title: data.title,
    text: truncated ? `${data.text.slice(0, limit)}\n\n… [dsh-moli] ${String(data.text.length - limit)} characters omitted; pass a larger maxChars to keep them.` : data.text,
    chars: data.text.length,
    truncated,
    links: data.links,
    fields: data.forms,
    ...(includeHtml === true ? { html: data.html.slice(0, limit) } : {}),
  };
}

// ---------------------------------------------------------------------------
// the action table
// ---------------------------------------------------------------------------

/**
 * Run one action against a live connection.
 *
 * @param connection - the CDP connection from {@link SessionManager#ensure}.
 * @param args - the tool arguments.
 * @param options - output limits, the backend's geometry frame, and the browser.
 * @returns the action's value.
 */
export async function performAction(connection, args, options) {
  const action = args.action;
  const timeoutMs = args.timeoutMs ?? 30000;
  // Which frame element geometry lives in. Always supplied by the session; the
  // default keeps a direct call from behaving surprisingly.
  const geometry = options.geometry === 'viewport' ? 'viewport' : 'absolute';

  switch (action) {
    case 'open': {
      if (typeof args.url !== 'string' || args.url === '') return { ok: false, error: 'open needs a url' };
      await connection.send('Page.navigate', { url: args.url }, timeoutMs);
      const result = await settle(connection, { timeoutMs });
      const url = await connection.evaluate('location.href');
      const title = await connection.evaluate('document.title');
      return { ok: true, action, url: url.value, title: title.value, settled: result.settled, settledMs: result.ms };
    }

    case 'snapshot':
      return snapshot(connection, { maxChars: args.maxChars ?? options.maxChars, includeHtml: args.includeHtml === true });

    case 'click': {
      if (typeof args.selector !== 'string' || args.selector === '') return { ok: false, error: 'click needs a selector' };
      const before = await connection.evaluate('location.href');
      const outcome = await clickSelector(connection, args.selector, geometry);
      if (outcome.ok !== true) return { ok: false, action, selector: args.selector, ...outcome };
      // A click may navigate, open a dialog, or only run a handler; settling
      // covers the first, and reporting the URL change covers all three.
      const settled = await settle(connection, { timeoutMs: Math.min(timeoutMs, 10000) });
      const after = await connection.evaluate('location.href');
      return {
        ok: true,
        action,
        selector: args.selector,
        clicked: { tag: outcome.found.tag, text: outcome.found.text, x: Math.round(outcome.x), y: Math.round(outcome.y) },
        navigated: before.value !== after.value,
        url: after.value,
        settled: settled.settled,
      };
    }

    case 'type': {
      if (typeof args.selector !== 'string' || args.selector === '') return { ok: false, error: 'type needs a selector' };
      if (typeof args.text !== 'string') return { ok: false, error: 'type needs text' };
      // Measure first so a field that cannot be reached is reported rather than
      // silently typed into nowhere. Focusing also scrolls, which is what the
      // standard frame needs.
      const found = await ensureVisible(connection, args.selector, geometry);
      if (found.error !== undefined) return { ok: false, error: found.error, selector: args.selector };
      const focused = await connection.evaluate(
        `(() => { const el = document.querySelector(${quote(args.selector)}); if (el === null) return 'missing'; el.focus(); ${args.clear === true ? 'if ("value" in el) { el.value = ""; }' : ''} return document.activeElement === el ? 'focused' : 'not-focused'; })()`);
      if (focused.value !== 'focused') return { ok: false, error: `could not focus ${JSON.stringify(args.selector)} (${String(focused.value ?? focused.throws)})` };
      await connection.send('Input.insertText', { text: args.text });
      let submitted = false;
      if (args.submit === true) {
        await keyPress(connection, 'Enter');
        submitted = true;
        await settle(connection, { timeoutMs: Math.min(timeoutMs, 10000) });
      }
      const value = await connection.evaluate(`(() => { const el = document.querySelector(${quote(args.selector)}); return el === null ? null : (el.value ?? el.innerText ?? null); })()`);
      return { ok: true, action, selector: args.selector, submitted, value: value.value };
    }

    case 'cdp': {
      // The escape hatch. Every action above is an abstraction chosen in advance;
      // this one is not, and it reaches what they do not: attaching to another
      // target, cross-origin frames, file inputs (`DOM.setFileInputFiles`), extra
      // headers (`Network.setExtraHTTPHeaders`), and anything else the protocol
      // offers. Agents have seen far more CDP than any wrapper can anticipate.
      if (typeof args.method !== 'string' || args.method === '') return { ok: false, error: 'cdp needs method, e.g. "Network.enable"' };
      let params = {};
      if (args.params !== undefined && args.params !== null) {
        if (typeof args.params === 'string') {
          try { params = JSON.parse(args.params); }
          catch (error) { return { ok: false, action, error: `params is not valid JSON: ${String(error.message)}` }; }
        } else if (typeof args.params === 'object') {
          params = args.params;
        } else {
          return { ok: false, action, error: 'params must be an object or a JSON string' };
        }
      }
      try {
        const result = await connection.send(args.method, params, timeoutMs);
        const serialized = JSON.stringify(result);
        const limit = args.maxChars ?? options.maxChars ?? 200000;
        const trimmed = typeof serialized === 'string' && serialized.length > limit;
        return {
          ok: true,
          action,
          method: args.method,
          result: trimmed ? undefined : result,
          serialized: trimmed ? `${serialized.slice(0, limit)}\n… [dsh-moli] truncated; pass a larger maxChars` : serialized,
          bytes: typeof serialized === 'string' ? serialized.length : 0,
        };
      } catch (error) {
        return {
          ok: false,
          action,
          method: args.method,
          error: error instanceof Error ? error.message : String(error),
          hint: 'The protocol rejected the command. Check the method name and its parameters against the CDP reference; `Runtime.evaluate` with a script is often easier than several low-level calls.',
        };
      }
    }

    case 'press':
      if (typeof args.key !== 'string' || args.key === '') return { ok: false, error: 'press needs key' };
      await keyPress(connection, args.key);
      return { ok: true, action, key: args.key };

    case 'scroll': {
      let expression;
      if (typeof args.selector === 'string' && args.selector !== '') {
        expression = `(() => { const el = document.querySelector(${quote(args.selector)}); if (el === null) return null; el.scrollIntoView({ block: '${String(args.block ?? 'center')}' }); return window.scrollY; })()`;
      } else {
        const dy = typeof args.dy === 'number' ? args.dy : 800;
        expression = `(() => { window.scrollBy(0, ${String(dy)}); return window.scrollY; })()`;
      }
      const result = await connection.evaluate(expression);
      if (result.value === null) return { ok: false, error: `no element matches ${JSON.stringify(String(args.selector))}` };
      // In the standard frame the scroll has to take effect before the position is
      // reported, or the caller sees the old value and thinks nothing moved.
      if (geometry === 'viewport') await sleep(60);
      const metrics = await connection.evaluate('JSON.stringify({ y: window.scrollY, height: document.body === null ? 0 : document.body.scrollHeight, viewport: innerHeight })');
      return { ok: true, action, ...JSON.parse(String(metrics.value)) };
    }

    case 'waitFor': {
      if (typeof args.selector !== 'string' || args.selector === '') return { ok: false, error: 'waitFor needs a selector' };
      const deadline = Date.now() + timeoutMs;
      const start = Date.now();
      // `detached` means the selector matches nothing. It is deliberately not
      // "hidden": a `display:none` element still matches, and conflating the two
      // would make this wait forever on something the caller can already see is
      // absent from the DOM.
      const wantPresent = args.state !== 'detached';
      for (;;) {
        const present = (await connection.evaluate(`document.querySelector(${quote(args.selector)}) !== null`)).value === true;
        if (present === wantPresent) {
          return {
            ok: true, action, selector: args.selector,
            state: present ? 'attached' : 'detached',
            waitedMs: Date.now() - start,
          };
        }
        if (Date.now() > deadline) {
          return {
            ok: false, action, selector: args.selector,
            error: `timed out after ${String(timeoutMs)}ms waiting for ${JSON.stringify(args.selector)} to be ${wantPresent ? 'attached' : 'detached'}`,
            // A hidden element still matches the selector, which is the usual
            // reason someone reaches for `detached` and waits for ever.
            hint: '`detached` means the element is absent from the DOM; a hidden element still matches the selector. Use eval to check getComputedStyle, or wait for the attribute or class that hides it.',
          };
        }
        await sleep(150);
      }
    }

    case 'eval': {
      if (typeof args.expression !== 'string' || args.expression === '') return { ok: false, error: 'eval needs expression' };
      const result = await connection.evaluate(args.expression, { awaitPromise: true, timeoutMs });
      if (result.throws !== undefined) return { ok: false, action, error: result.throws, hint: 'The expression threw. Check that the page is in the state you expect and that the selector matches an element.' };
      const value = result.value;
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      return { ok: true, action, value, serialized: serialized ?? 'undefined' };
    }

    case 'screenshot': {
      const result = await connection.send('Page.captureScreenshot', { format: args.format ?? 'png' }, timeoutMs);
      const data = result.data;
      if (typeof data !== 'string') return { ok: false, error: 'the engine returned no image data' };
      if (typeof args.writeTo !== 'string' || args.writeTo === '') {
        return { ok: false, error: 'screenshot needs writeTo (an absolute path): the image cannot be returned inline', bytes: Buffer.from(data, 'base64').length };
      }
      const directory = dirname(args.writeTo);
      if (!existsSync(directory)) return { ok: false, error: `the destination directory does not exist: ${directory}` };
      const buffer = Buffer.from(data, 'base64');
      writeFileSync(args.writeTo, buffer);
      return { ok: true, action, path: args.writeTo, bytes: buffer.length, format: args.format ?? 'png' };
    }

    case 'status':
      return { ok: true, action };

    case 'close':
      return { ok: true, action };

    default:
      return { ok: false, error: `unknown action ${JSON.stringify(String(action))}` };
  }
}

/**
 * Press one key.
 *
 * The engine needs the key, the code and the legacy virtual key code to produce a
 * complete event; `Enter` also needs the character fields, which is why the table
 * carries more than the key name.
 */
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Delete: { code: 'Delete', keyCode: 46 },
};

async function keyPress(connection, name) {
  const spec = KEYS[name] ?? { code: name, keyCode: 0 };
  const base = { key: name, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  const down = { ...base, type: spec.text === undefined ? 'rawKeyDown' : 'keyDown' };
  if (spec.text !== undefined) down.text = spec.text;
  await connection.send('Input.dispatchKeyEvent', down);
  await connection.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

/** Exported for tests: the selector-and-box step, without an input dispatch. */
export const __internal = { boxOf, ensureVisible, settle, snapshot, KEYS };
