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
 * Resolve a selector to a click point, or explain why there is not one.
 *
 * **This engine's geometry is document-absolute and ignores scrolling.**
 * `getBoundingClientRect()` returns the same `y` at `scrollY` 0, 400 and 800, and
 * `elementFromPoint()` agrees with it -- scanning the hit test at
 * `rect.y + scrollY` returns null while `rect.y` hits the element. The mouse
 * input APIs share that frame, so a click dispatched at `rect.y` lands even when
 * the page is scrolled.
 *
 * Measured against moli 1.1.16. This is not the web platform's behaviour, and it
 * matters: the textbook recipe of "scroll the element into view, then read the
 * viewport rectangle" produces coordinates that are wrong by the scroll offset,
 * and the failure is silent on a short page and total on a long one. Nothing here
 * may depend on the scroll position.
 *
 * @returns `{ box, point, tag, text, covered }` on success, `{ error }` otherwise.
 */
async function boxOf(connection, selector) {
  const expression = `(() => {
    const el = document.querySelector(${quote(selector)});
    if (el === null) return { missing: true };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // The hit test is the authority on whether a click can land, and it uses the
    // same frame as the rectangle. An element that is scrolled out of view still
    // passes, because in this engine the input is not clipped to the viewport.
    const found = document.elementFromPoint(cx, cy);
    const hitSelf = found !== null && (found === el || el.contains(found) || found.contains(el));
    return {
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      point: hitSelf ? { x: cx, y: cy } : null,
      covered: hitSelf || found === null ? null : found.tagName.toLowerCase() + (found.id ? '#' + found.id : ''),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      visible: style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0,
      scrollY: window.scrollY,
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
 * Measure a selector.
 *
 * `scrollIntoView` is attempted because it is harmless and does move the page for
 * a human reading it, but nothing here depends on it: the geometry does not
 * follow the scroll, so the measurement is identical either way. See {@link boxOf}
 * for the engine detail and its consequence.
 */
async function ensureVisible(connection, selector) {
  await connection.evaluate(`(() => {
    const el = document.querySelector(${quote(selector)});
    if (el !== null) el.scrollIntoView({ block: 'center', inline: 'center' });
  })()`);
  await sleep(50);
  return boxOf(connection, selector);
}

/**
 * Turn a measurement into a click that is known to land on the element.
 *
 * A click outside the viewport, or one whose point is covered by another element,
 * is reported rather than dispatched: dispatching anyway produces a silent no-op
 * that looks like success to the caller.
 */
async function clickSelector(connection, selector) {
  const found = await ensureVisible(connection, selector);
  if (found.error !== undefined) return { ok: false, error: found.error };
  if (found.visible !== true) return { ok: false, error: `${JSON.stringify(selector)} is not visible (display:none or visibility:hidden)` };
  if (found.point === null) {
    // The engine's hit test is clipped to the viewport height while its geometry
    // ignores scrolling, so an element whose absolute y is past the viewport
    // cannot be reached by synthetic input at all -- scrolling does not change
    // either number. Report that plainly and point at the route that does work.
    const beyondViewport = found.box.y + found.box.height / 2 > (found.viewportHeight ?? 0);
    return {
      ok: false,
      selector,
      error: found.covered === null
        ? (beyondViewport
          ? `${JSON.stringify(selector)} is below the viewport (y=${String(Math.round(found.box.y))}) and this engine cannot send input there`
          : `${JSON.stringify(selector)} has no box to click`)
        : `${JSON.stringify(selector)} is covered by another element (${found.covered})`,
      hint: beyondViewport
        ? 'Moli\'s hit test is bounded by the viewport height and its element geometry does not follow scrolling, so synthetic clicks cannot reach elements further down the document. Use eval to click it in the page instead -- for example `document.querySelector("SEL").click()` -- which bypasses the input layer entirely.'
        : found.covered === null
          ? 'The element may be display:none, zero-sized, or only a wrapper.'
          : 'Something is on top of it -- commonly a consent banner or a modal. Dismiss that first, or press Escape.',
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
 * @param options - output limits and the resolved session manager.
 * @returns the action's value.
 */
export async function performAction(connection, args, options) {
  const action = args.action;
  const timeoutMs = args.timeoutMs ?? 30000;

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
      const outcome = await clickSelector(connection, args.selector);
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
      // Same measurement discipline as click: a field far down the page has to be
      // scrolled into view before it can be focused and typed into reliably.
      const found = await ensureVisible(connection, args.selector);
      if (found.error !== undefined) return { ok: false, error: found.error, selector: args.selector };
      // Focus through the page so the element is the real editing target, then
      // clear it when asked: typing into a pre-filled field would append.
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
