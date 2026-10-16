/**
 * dsh-moli — browser half.
 *
 * Settings section (Moli install & fetch): the plugin's configuration —
 * engine lifecycle (install / uninstall), forward proxy, per-call timeout,
 * inline truncation budget, the TLS no-verify switch, and the engine path —
 * edited on the plugin's page in the Plugins manager.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 */
window.__ModuleLoader__.load({
  id: "dsh-moli",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (theme tokens, same vocabulary as dsh-soul-md) ────────────────
    var CSS = ".__moli_root{max-width:640px;display:flex;flex-direction:column;gap:10px}" +
      ".__moli_field{display:flex;flex-direction:column;gap:4px}" +
      ".__moli_label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__moli_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__moli_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 10px;font-size:13px;box-sizing:border-box;width:100%}" +
      ".__moli_actions{display:flex;gap:8px;align-items:center;margin-top:4px}" +
      ".__moli_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}" +
      ".__moli_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__moli_btn:disabled{opacity:.5;cursor:default}" +
      ".__moli_btnPrimary{border-color:var(--dsw-alias-state-business-primary, #3964fe);background:var(--dsw-alias-state-business-primary, #3964fe);color:#fff}" +
      ".__moli_btnDanger{border-color:var(--dsw-alias-state-error-primary, #f85149);color:var(--dsw-alias-state-error-primary, #f85149)}" +
      ".__moli_status{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__moli_error{font-size:12px;color:var(--dsw-alias-state-error-primary)}" +
      ".__moli_unavailable{font-size:13px;color:var(--dsw-alias-label-tertiary)}" +
      ".__moli_group{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      ".__moli_engineRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".__moli_engineState{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600}" +
      ".__moli_engineDetail{font-size:11px;color:var(--dsw-alias-label-tertiary)}";
    if (typeof document !== "undefined") {
      var style = document.createElement("style");
      style.textContent = CSS;
      style.setAttribute("data-dsh-moli", "");
      if (!document.head.querySelector("style[data-dsh-moli]")) document.head.appendChild(style);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var zh = {
      nav: "Moli 设置",
      sectionTitle: "Moli 安装与抓取",
      unavailable: "配置不可用（可能当前 profile 未启用本插件）。",
      loading: "正在读取配置…",
      saved: "已保存。",
      save: "保存",
      error: "保存失败",
      notApplied: "写入被宿主拒绝，表单已按宿主实际状态刷新。",
      engineSection: "引擎",
      engineInstalled: "已安装",
      engineMissing: "未安装",
      engineUnknown: "检测中…",
      engineWorking: "正在处理…",
      engineActionInstall: "安装引擎",
      engineActionUninstall: "卸载引擎",
      engineVersion: "版本 {version}",
      engineInstallHint: "未检测到 Moli 引擎。点击「安装引擎」下载官方安装器并运行（需联网，可能耗时数分钟）。",
      engineUninstallHint: "点击「卸载引擎」将删除本机安装的 Moli 二进制。",
      fieldProxy: "转发代理",
      hintProxy: '每次调用的代理覆盖项；留空表示直连。例如 "http://127.0.0.1:7890"。回环地址总是绕过代理。',
      fieldDefaultTimeoutMs: "默认超时（毫秒）",
      hintDefaultTimeoutMs: "单次调用默认超时，默认 30000（30 秒）。",
      fieldMaxChars: "内联文本截断（字符）",
      hintMaxChars: "内联文本最多返回的字符数，默认 200000；超出时保留头尾并注明省略量，传 writeTo 可保留全文。",
      fieldInsecureTls: "跳过 TLS 验证（insecureTls）",
      hintInsecureTls: '本网络证书吊销应答不可达时，GitHub 等 HTTPS 主机可能报错；开启后透传 moli 的 no-verify 标志。默认开启。',
      fieldExePath: "引擎路径（exePath）",
      hintExePath: "可选。指定 moli 可执行文件的绝对路径；留空则自动在常见安装位置查找。",
      placeholderProxy: "http://127.0.0.1:7890",
      placeholderExePath: "/home/user/.local/bin/moli",
    };
    var en = {
      nav: "Moli settings",
      sectionTitle: "Moli install & fetch",
      unavailable: "Configuration unavailable (this profile may not enable the plugin).",
      loading: "Loading configuration…",
      saved: "Saved.",
      save: "Save",
      error: "Save failed",
      notApplied: "The write was refused by the host; the form was reloaded to what the host actually holds.",
      engineSection: "Engine",
      engineInstalled: "Installed",
      engineMissing: "Not installed",
      engineUnknown: "Detecting…",
      engineWorking: "Working…",
      engineActionInstall: "Install engine",
      engineActionUninstall: "Uninstall engine",
      engineVersion: "version {version}",
      engineInstallHint: "No Moli engine found. Click “Install engine” to download and run the official installer (needs network; may take a few minutes).",
      engineUninstallHint: "Click “Uninstall engine” to remove the locally installed Moli binary.",
      fieldProxy: "Forward proxy",
      hintProxy: 'Per-call proxy override; leave empty for direct. E.g. "http://127.0.0.1:7890". Loopback URLs always bypass it.',
      fieldDefaultTimeoutMs: "Default timeout (ms)",
      hintDefaultTimeoutMs: "Per-call default timeout; 30000 (30 s) by default.",
      fieldMaxChars: "Inline truncation budget (chars)",
      hintMaxChars: "Max characters returned inline; 200000 by default. Beyond it the head and tail are kept with an omitted-count note; pass writeTo to keep everything.",
      fieldInsecureTls: "Skip TLS verification (insecureTls)",
      hintInsecureTls: "When this network's CRL/OCSP responder is unreachable, HTTPS hosts like GitHub fail; enabling passes moli's no-verify flag. On by default.",
      fieldExePath: "Engine path (exePath)",
      hintExePath: "Optional. Absolute path to the moli executable; leave empty to search the usual install locations.",
      placeholderProxy: "http://127.0.0.1:7890",
      placeholderExePath: "/home/user/.local/bin/moli",
    };

    // ── write helper (same contract as dsh-soul-md) ───────────────────────
    function settingsOpsApplied(snapshot, ops) {
      var v = snapshot && snapshot.status === "ready" ? snapshot.value : void 0;
      if (v === void 0) return false;
      return ops.every(function (op) {
        if (op.op === "unset") return v[op.path[0]] === void 0;
        return v[op.path[0]] === op.value;
      });
    }
    function commitSettingsOps(scope, ops) {
      if (ops.length === 0) return Promise.resolve(true);
      var run;
      if (typeof scope.mutate === "function") {
        run = scope.mutate(ops, scope.getSnapshot().revision);
      } else {
        run = ops.reduce(function (chain, op) {
          return chain.then(function () {
            return op.op === "unset" ? scope.unset(op.path[0]) : scope.set(op.path[0], op.value);
          });
        }, Promise.resolve());
      }
      return Promise.resolve(run).then(function () {
        return settingsOpsApplied(scope.getSnapshot(), ops);
      });
    }

    // ── field descriptors ─────────────────────────────────────────────────
    // `select` fields store booleans (single option pair); the draft holds the
    // string option and the ops map it back to a boolean.
    var FIELDS = [
      { key: "proxy", label: "fieldProxy", type: "text", hint: "hintProxy", placeholder: "placeholderProxy" },
      { key: "defaultTimeoutMs", label: "fieldDefaultTimeoutMs", type: "number", min: 1000, hint: "hintDefaultTimeoutMs" },
      { key: "maxChars", label: "fieldMaxChars", type: "number", min: 100, hint: "hintMaxChars" },
      { key: "insecureTls", label: "fieldInsecureTls", type: "select", options: [["true", "true"], ["false", "false"]], hint: "hintInsecureTls" },
      { key: "exePath", label: "fieldExePath", type: "text", hint: "hintExePath", placeholder: "placeholderExePath" },
    ];
    function toDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i];
        var v = value && value[f.key];
        if (f.type === "number") out[f.key] = typeof v === "number" ? String(v) : "";
        else if (f.type === "select") out[f.key] = v ? "true" : "false";
        else out[f.key] = typeof v === "string" ? v : "";
      }
      return out;
    }
    function draftOps(draft) {
      var ops = [];
      for (var i = 0; i < FIELDS.length; i++) {
        var f = FIELDS[i];
        if (f.type === "number") {
          var n = Number(draft[f.key]);
          if (draft[f.key] !== "" && Number.isFinite(n)) ops.push({ op: "set", path: [f.key], value: n });
        } else if (f.type === "select") {
          ops.push({ op: "set", path: [f.key], value: draft[f.key] === "true" });
        } else {
          ops.push({ op: "set", path: [f.key], value: typeof draft[f.key] === "string" ? draft[f.key] : "" });
        }
      }
      return ops;
    }

    // ── settings section ──────────────────────────────────────────────────
    function MoliConfigSection(props) {
      useLocale(props.locale);
      var t = props.t;
      var scope = props.scope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState(null);
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);
      var writePending = react.useRef(false);

      react.useEffect(function () {
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        // Bound once per plugin, shared across mounts: unmount only unsubscribes,
        // never disposes, so a later remount does not find a dead write queue.
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__moli_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__moli_status" }, t("loading"));

      var value = snapshot.value;
      var currentDraft = draft === null ? toDraft(value) : draft;
      var valueKey = JSON.stringify(toDraft(value));
      var draftKey = JSON.stringify(currentDraft);
      var dirty = valueKey !== draftKey;
      var saving = busy;

      function setField(f, v) { setNotice(null); setError(null); setDraft(function (p) { return Object.assign({}, p, { [f.key]: v }); }); }

      function onSave() {
        if (writePending.current) return;
        writePending.current = true;
        setBusy(true); setNotice(null); setError(null);
        commitSettingsOps(scope, draftOps(currentDraft)).then(function (ok) {
          writePending.current = false;
          setBusy(false);
          setSnapshot(scope.getSnapshot());
          if (!ok) { setError(t("notApplied")); return; }
          setNotice(t("saved"));
          setDraft(null);
        }).catch(function (e) {
          writePending.current = false;
          setBusy(false);
          setSnapshot(scope.getSnapshot());
          setError(String(e && e.message || e));
        });
      }

      // Engine lifecycle: the Host reacts to `engineAction` and reports back
      // through `engineState` / `engineVersion`. While the action is pending the
      // form shows "working…"; scope updates (including the reset to `none`)
      // drive the display back to the resulting state.
      var engineState = typeof value.engineState === "string" ? value.engineState : "unknown";
      var engineVersion = typeof value.engineVersion === "string" ? value.engineVersion : "";
      var engineAction = typeof value.engineAction === "string" ? value.engineAction : "none";
      var engineWorking = engineAction !== "none";
      var engineLabel = engineWorking ? t("engineWorking")
        : engineState === "installed" ? t("engineInstalled")
          : engineState === "missing" ? t("engineMissing")
            : t("engineUnknown");

      function onEngineAction(action) {
        if (engineWorking) return;
        if (action === "uninstall" && !window.confirm(t("engineUninstallHint"))) return;
        setNotice(null); setError(null);
        commitSettingsOps(scope, [{ op: "set", path: ["engineAction"], value: action }]).then(function (ok) {
          setSnapshot(scope.getSnapshot());
          if (!ok) setError(t("notApplied"));
        }).catch(function (e) {
          setSnapshot(scope.getSnapshot());
          setError(String(e && e.message || e));
        });
      }

      return h("div", { className: "__moli_root" },
        // Engine lifecycle group.
        h("div", { className: "__moli_group" },
          h("div", { className: "__moli_label" }, t("engineSection")),
          h("div", { className: "__moli_engineRow" },
            h("span", { className: "__moli_engineState" }, engineLabel),
            engineVersion && engineState === "installed"
              ? h("span", { className: "__moli_engineDetail" }, t("engineVersion").replace("{version}", engineVersion))
              : null,
          ),
          engineState !== "installed" && !engineWorking
            ? h("span", { className: "__moli_engineDetail" }, t("engineInstallHint"))
            : engineState === "installed" && !engineWorking
              ? h("span", { className: "__moli_engineDetail" }, t("engineUninstallHint"))
              : null,
          h("div", { className: "__moli_actions" },
            engineState === "installed"
              ? h("button", { className: "__moli_btn __moli_btnDanger", disabled: engineWorking, onClick: function () { onEngineAction("uninstall"); } }, t("engineActionUninstall"))
              : h("button", { className: "__moli_btn __moli_btnPrimary", disabled: engineWorking, onClick: function () { onEngineAction("install"); } }, t("engineActionInstall")),
          ),
        ),
        // Configuration fields group.
        h("div", { className: "__moli_group" },
          FIELDS.map(function (f) {
            if (f.type === "select") {
              return h("label", { key: f.key, className: "__moli_field" },
                h("span", { className: "__moli_label" }, t(f.label)),
                h("select", {
                  className: "__moli_input",
                  value: currentDraft[f.key],
                  onChange: function (e) { setField(f, e.target.value); },
                }, f.options.map(function (o) {
                  // Option labels are the raw stored values ("true"/"false"),
                  // never translated; only the field label and hint are locale-bound.
                  return h("option", { key: o[0], value: o[0] }, o[1]);
                })),
                f.hint ? h("span", { className: "__moli_hint" }, t(f.hint)) : null,
              );
            }
            return h("label", { key: f.key, className: "__moli_field" },
              h("span", { className: "__moli_label" }, t(f.label)),
              h("input", {
                className: "__moli_input",
                type: f.type === "number" ? "number" : "text",
                min: f.min,
                value: currentDraft[f.key],
                placeholder: f.placeholder ? t(f.placeholder) : void 0,
                onChange: function (e) { setField(f, e.target.value); },
              }),
              f.hint ? h("span", { className: "__moli_hint" }, t(f.hint)) : null,
            );
          }),
          h("div", { className: "__moli_actions" },
            h("button", { className: "__moli_btn __moli_btnPrimary", disabled: saving || !dirty, onClick: onSave }, t("save")),
            notice ? h("span", { className: "__moli_status" }, notice) : null,
            error ? h("span", { className: "__moli_error" }, error) : null,
          ),
        ),
      );
    }

    var NS = "dsh-moli";

    // Keep the section re-rendering when the active locale changes.
    function useLocale(locale) {
      var refresh = react.useState(0)[1];
      react.useEffect(function () {
        if (!locale || typeof locale.subscribe !== "function") return;
        return locale.subscribe(function () { refresh(function (revision) { return revision + 1; }); });
      }, [locale]);
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-moli: dictionaries");
      var scope = ctx.configForms.get("dsh-moli");
      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register({
          name: "plugins.bundle.config",
          key: "dsh-moli",
          locale: NS
        }, function (props) {
          return h(MoliConfigSection, Object.assign({}, props, { scope: scope, t: t, locale: ctx.locale }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale", "configForms"];
    return module.exports;
  }
});
