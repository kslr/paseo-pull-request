import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { build, transform } from "esbuild";
import * as zod from "zod";

// The modules a Paseo client provides to plugin bundles; the compiler leaves them external.
const HOST_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
  "@tanstack/react-query",
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/react-native",
  "@getpaseo/plugin/client/ui",
];

const root = path.resolve(import.meta.dirname, "..");
// Match Paseo's client compiler (server/plugins/compiler-build.js), including its eager namespace
// interop. 0.15 adds tree shaking, the SVG text loader and a minify pass after the eager rewrite;
// the manifest still accepts 0.13, so both outputs must load.
const result = await build({
  entryPoints: [path.join(root, "index.client.tsx")],
  bundle: true,
  format: "cjs",
  jsx: "automatic",
  loader: { ".svg": "text" },
  platform: "neutral",
  target: "es2020",
  mainFields: ["module", "main"],
  supported: { "async-await": false },
  external: HOST_MODULES,
  treeShaking: true,
  write: false,
  logLevel: "silent",
});
const eager = result.outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]");
const minified = await transform(eager, {
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  target: "es2020",
  supported: { "async-await": false },
  charset: "ascii",
  legalComments: "inline",
});
const wrap = (code) => `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
const sources = { "0.13": wrap(eager), "0.15": wrap(minified.code) };
function load(source, platform, effects = []) {
  const native = { Platform: { OS: platform } };
  // RN exposes native components through getters. Merely loading the plugin must not enumerate
  // them: Paseo's eager interop would initialize every one of them on iOS.
  Object.defineProperty(native, "UnrelatedNativeModule", {
    enumerable: true,
    get() { throw new Error("Unrelated native module was initialized"); },
  });
  const modules = Object.fromEntries(HOST_MODULES.map((name) => [name, {}]));
  Object.assign(modules, {
    "react-native": native,
    zod,
    "@getpaseo/plugin": { defineRpc: (contract) => contract },
    react: {
      useEffect: (effect) => effects.push(effect),
      useRef: () => ({ current: null }),
    },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "@getpaseo/plugin/client/ui": { useToast: () => ({ show() {} }) },
  });
  const globals = { AbortController, setTimeout, clearTimeout, console };
  if (platform === "web") globals.HTMLElement = function HTMLElement() {};
  return vm.runInNewContext(source, globals)((name) => {
    assert.ok(name in modules, `Unexpected host module: ${name}`);
    return modules[name];
  }).default;
}

for (const [version, compiled] of Object.entries(sources)) {
  test(`the entire catalog entry compiled by Paseo ${version} compiles with RN 0.81 Hermes`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-pr-hermes-"));
    try {
      const input = path.join(directory, "client.js");
      writeFileSync(input, compiled);
      const bin = process.platform === "darwin" ? "osx-bin/hermesc" : process.platform === "win32" ? "win64-bin/hermesc.exe" : "linux64-bin/hermesc";
      const hermes = spawnSync(path.join(root, "node_modules/react-native/sdks/hermesc", bin), ["-emit-binary", "-out", path.join(directory, "client.hbc"), input], { encoding: "utf8" });
      assert.ifError(hermes.error);
      assert.equal(hermes.status, 0, hermes.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const [version, source] of Object.entries(sources)) {
  for (const platform of ["ios", "android"]) {
    test(`Paseo ${version}: ${platform} registers the panel and its command, without native module initialization or subscriptions`, () => {
      const contribute = load(source, platform);
      const surfaces = [];
      const removed = [];
      const register = (surface) => {
        surfaces.push(surface.id);
        return () => removed.push(surface.id);
      };
      // The Create PR button stays desktop-only, so nothing else on the client is touched.
      const client = new Proxy({ addWorkspacePanel: register, addCommandCenterItem: register }, {
        get(target, key) {
          if (key in target) return target[key];
          throw new Error(`Native client accessed ${String(key)}`);
        },
      });
      contribute(client)();
      assert.deepEqual(surfaces.sort(), ["open-pull-request", "pull-request"]);
      assert.equal(removed.length, 2);
    });
  }

  for (const outcome of ["succeeded", "failed"]) {
    test(`Paseo ${version}: desktop retains its surfaces and Create PR lifecycle when the action ${outcome}`, async () => {
      const effects = [];
      const contribute = load(source, "web", effects);
      const surfaces = [];
      const removed = [];
      const buttons = [];
      const calls = [];
      let opened = 0;
      let unsubscribed = 0;
      let released = 0;
      const workspace = { id: "workspace", projectKind: "git", archivingAt: null, workspaceDirectory: "/repo" };
      const status = {
        isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "feature/test",
        hasWorkingTreeChanges: true, hasUpstream: true, aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 0, pr: null,
      };
      const client = {
        ...Object.fromEntries(["addWorkspacePanel", "addCommandCenterItem"].map((method) => [method, (surface) => {
          surfaces.push(surface.id);
          return () => removed.push(surface.id);
        }])),
        paseo: { workspaces: { list: async () => ({
          entries: [workspace],
          subscription: { subscribe: () => () => unsubscribed++, release: async () => { released++; } },
        }) } },
        addHeaderButton({ button }) {
          buttons.push(button);
          return { update: (patch) => Object.assign(button, patch), remove: () => removed.push("button") };
        },
        async rpc(contract, input) {
          calls.push({ name: contract.name, input });
          if (contract.name === "git.status") return status;
          if (contract.name === "git.create-pr.start") return { status: "running", label: "Pushing...", lastOutputLine: null, phaseStartedAt: Date.now() };
          assert.equal(contract.name, "git.create-pr.run");
          return outcome === "failed"
            ? { status: "failed", message: "Push rejected" }
            : { status: "succeeded", result: { branch: null, commit: null, pr: { status: "created", number: 8, url: "https://github.com/o/r/pull/8", title: "Add things" } } };
        },
        openPanel(id) { assert.equal(id, "pull-request"); opened++; },
      };
      const cleanup = contribute(client);
      await new Promise(setImmediate);
      assert.equal(surfaces.length, 2);
      assert.equal(buttons.length, 1);
      assert.equal(calls.length, 0, "Hidden buttons must not query Git");
      buttons[0].icon({ size: 16, color: "#fff", theme: { colors: { foreground: "#fff" } } });
      const unmount = effects.map((effect) => effect());
      await new Promise(setImmediate);
      assert.equal(calls[0].name, "git.status");
      const action = buttons[0].behavior.onPress();
      await new Promise(setImmediate);
      assert.match(buttons[0].label, /^Pushing/);
      if (outcome === "failed") await assert.rejects(action, /Push rejected/);
      else await action;
      assert.equal(calls[1].input.workspaceId, "workspace");
      assert.equal(calls[2].input.runId, calls[1].input.runId);
      assert.equal(opened, outcome === "succeeded" ? 1 : 0);
      assert.equal(buttons[0].label, "Create PR");
      unmount.forEach((dispose) => dispose?.());
      cleanup();
      assert.equal(removed.length, 3);
      assert.equal(unsubscribed, 1);
      assert.equal(released, 1);
    });
  }
}
