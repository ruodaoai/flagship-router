import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(PLUGIN_DIR, "bin", "flagship-router.mjs");

function run(mode, stdin = "") {
  const home = mkdtempSync(path.join(tmpdir(), "flagship-router-test-"));
  const res = spawnSync(process.execPath, [CLI, mode], {
    input: stdin,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, RUODAO_FLAGSHIP_HOME: home },
  });
  return { code: res.status, out: res.stdout, err: res.stderr, home };
}

function parseBody(out) {
  return JSON.parse(out.slice(out.indexOf("{")));
}

test("未知命令返回失败 JSON", () => {
  const { code, out } = run("nope");
  assert.equal(code, 1);
  const body = parseBody(out);
  assert.equal(body.state, "failed");
  assert.match(body.error, /未知命令/);
});

test("status 在未安装时返回可用的状态摘要", () => {
  const { out } = run("status");
  const body = parseBody(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.status.installed, false);
  assert.equal(body.status.running, false);
  assert.equal(body.status.nodeSupported, true);
  assert.ok(body.status.home);
});

test("install-status 初始为 idle 且已创建数据目录", () => {
  const { out, home } = run("install-status");
  const body = parseBody(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.install.status, "idle");
  assert.equal(body.installed, false);
  assert.ok(existsSync(home));
});

test("log 返回空日志不报错", () => {
  const { out } = run("log");
  const body = parseBody(out);
  assert.equal(body.state, "succeeded");
  assert.equal(body.installLog, "");
  assert.equal(body.gatewayLog, "");
});

test("core.missingBuildModules 识别上游 optional 依赖缺失", async () => {
  const core = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "core.mjs")).href);
  const appDir = mkdtempSync(path.join(tmpdir(), "flagship-router-app-"));
  // 上游把这两个模块写在 optionalDependencies，但 next build 会静态解析它们；
  // 用 --omit=optional 安装就会 module-not-found，一键安装必败。
  assert.deepEqual(core.missingBuildModules(appDir), [
    "better-sqlite3",
    "@aws-sdk/credential-providers",
  ]);
  for (const id of core.BUILD_REQUIRED_OPTIONAL) {
    const dir = path.join(appDir, "node_modules", ...id.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
  }
  assert.deepEqual(core.missingBuildModules(appDir), []);
});
test("core.dependenciesReady 只在依赖齐全时返回 true", async () => {
  const core = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "core.mjs")).href);
  const home = mkdtempSync(path.join(tmpdir(), "flagship-router-deps-"));
  const paths = core.resolvePaths(home);
  mkdirSync(paths.appDir, { recursive: true });
  assert.equal(core.dependenciesReady(paths), false);
  for (const id of ["next", ...core.BUILD_REQUIRED_OPTIONAL]) {
    const dir = path.join(paths.appDir, "node_modules", ...id.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
  }
  assert.equal(core.dependenciesReady(paths), true);
});
test("core.buildProviderPayload 组装 responses 提供方", async () => {
  const core = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "core.mjs")).href);
  const payload = core.buildProviderPayload({
    port: 20128,
    apiKey: "sk-test",
    models: [{ id: "m1", contextWindow: 64000 }, { id: "m2" }],
    activeModel: "m2",
  });
  assert.equal(payload.provider, "flagship-router");
  assert.equal(payload.wireApi, "responses");
  assert.equal(payload.baseUrl, "http://127.0.0.1:20128/v1");
  assert.equal(payload.model, "m2");
  assert.equal(payload.models.length, 2);
  assert.equal(payload.models[0].contextWindow, 64000);
  assert.throws(() => core.buildProviderPayload({ port: 1, models: [] }), /至少一个模型/);
});

test("core.normalizeModels 过滤非文本模型并合并 catalog", async () => {
  const core = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "core.mjs")).href);
  const models = core.normalizeModels(
    [
      { id: "gpt-a" },
      { id: "text-embedding-3" },
      { id: "gpt-b" },
    ],
    [
      { id: "gpt-a", name: "GPT A", ready: true, caps: { contextWindow: 200000 } },
      { id: "gpt-b", kind: "image", ready: true },
    ],
  );
  assert.deepEqual(models.map((m) => m.id), ["gpt-a"]);
  assert.equal(models[0].ready, true);
  assert.equal(models[0].contextWindow, 200000);
});

test("core.defaultSelectedModelIds 优先就绪模型并限量", async () => {
  const core = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib", "core.mjs")).href);
  const models = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, ready: i < 10 }));
  const selected = core.defaultSelectedModelIds(models);
  assert.equal(selected.length, 10);
  assert.deepEqual(core.defaultSelectedModelIds([{ id: "x" }]), ["x"]);
});
