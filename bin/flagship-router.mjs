#!/usr/bin/env node
/**
 * FlagshipRouter sidecar manager for the Ruodao desktop plugin.
 *
 * The gateway is a full Next.js app, so "install" downloads the upstream source,
 * installs dependencies and builds it in the background. Runtime secrets and the
 * generated provider API key live in the plugin data directory, never in the
 * repository. The host workbench registers the provider through custom-model:save,
 * which keeps model configuration single-sourced in the desktop app.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  DEFAULT_PORT,
  buildGatewayEnv,
  defaultSelectedModelIds,
  findFreePort,
  dependenciesReady,
  installedVersion,
  isInstalled,
  missingBuildModules,
  isNodeVersionSupported,
  newPassword,
  normalizeModels,
  parsePort,
  randomSecret,
  readInstallStatus,
  readLogTail,
  readState,
  resolveHome,
  resolvePaths,
  writeInstallStatus,
  writeState,
} from "../lib/core.mjs";

const CLI_PATH = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.resolve(path.dirname(CLI_PATH), "..");
const SOURCE_ZIP = "https://codeload.github.com/theRizwan/FlagshipRouter/zip/refs/heads/main";
const ARCHIVE_ZIP = "https://github.com/theRizwan/FlagshipRouter/archive/refs/heads/main.zip";
const NPM_TARBALL = "https://registry.npmjs.org/npm/-/npm-10.9.2.tgz";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function succeed(data = {}) {
  emit({ state: "succeeded", ...data });
}

function fail(error, hint = "") {
  const message = error instanceof Error ? error.message : String(error ?? "未知错误");
  emit({ state: "failed", error: message, ...(hint ? { hint } : {}) });
  process.exitCode = 1;
}

async function readPayload() {
  if (!process.stdin || process.stdin.isTTY) return {};
  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function configFrom(payload = {}) {
  return payload && typeof payload.config === "object" && payload.config ? { ...payload.config } : {};
}

function pathsFor(config) {
  const paths = resolvePaths(resolveHome(config));
  for (const dir of [paths.home, paths.dataDir, paths.cacheDir, paths.toolsDir]) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text, "utf8");
  } catch {
    // Logging must never break installation.
  }
}

function assertNode() {
  if (!isNodeVersionSupported()) {
    throw new Error(`FlagshipRouter 需要 Node.js 20.9 或更高版本，当前为 ${process.versions.node}`);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function isUp(port) {
  if (!port) return false;
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/`, { redirect: "manual" }, 2500);
    return response.status < 500;
  } catch {
    return false;
  }
}

async function verifyApiKey(port, apiKey) {
  if (!port || !apiKey) return false;
  try {
    const response = await fetchWithTimeout(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    }, 15000);
    return response.ok;
  } catch {
    return false;
  }
}

async function canListen(port) {
  return await new Promise((resolve) => {
    const server = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    if (server.error) { resolve(false); return; }
    import("node:net").then(({ default: net }) => {
      const probe = net.createServer();
      probe.unref();
      probe.once("error", () => resolve(false));
      probe.listen({ port, host: "127.0.0.1" }, () => probe.close(() => resolve(true)));
    }).catch(() => resolve(false));
  });
}

function ensureState(paths, config) {
  const state = readState(paths);
  const configuredPort = parsePort(config.RUODAO_FLAGSHIP_PORT, 0);
  state.port = Number(state.port) || configuredPort || DEFAULT_PORT;
  state.password = String(state.password || config.RUODAO_FLAGSHIP_PASSWORD || newPassword());
  state.jwtSecret = String(state.jwtSecret || randomSecret(32));
  state.apiKeySecret = String(state.apiKeySecret || randomSecret(24));
  state.machineSalt = String(state.machineSalt || randomSecret(16));
  state.version = installedVersion(paths) || state.version || "";
  state.installedAt = state.installedAt || new Date().toISOString();
  writeState(paths, state);
  return state;
}

async function statusOf(paths, config) {
  const state = readState(paths);
  const installed = isInstalled(paths);
  const port = Number(state.port) || 0;
  const running = port ? await isUp(port) : false;
  return {
    installed,
    version: installedVersion(paths),
    running,
    port,
    dashboardUrl: port ? `http://127.0.0.1:${port}/` : "",
    password: String(state.password || ""),
    apiKey: String(config.RUODAO_FLAGSHIP_API_KEY || state.apiKey || ""),
    nodeVersion: process.versions.node,
    nodeSupported: isNodeVersionSupported(),
    install: readInstallStatus(paths),
    home: paths.home,
  };
}

/* ── install ─────────────────────────────────────────────────────────── */

async function downloadTo(url, dest, label) {
  const response = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: { "user-agent": "ruodao-flagship-router-plugin" },
  }, 10 * 60 * 1000);
  if (!response.ok || !response.body) throw new Error(`${label}下载失败（HTTP ${response.status}）`);
  const total = Number(response.headers.get("content-length") || 0);
  const file = fs.createWriteStream(dest);
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (!file.write(buffer)) await new Promise((resolve) => file.once("drain", resolve));
      if (Date.now() - lastReport > 2000) {
        lastReport = Date.now();
        const mb = (received / 1024 / 1024).toFixed(1);
        const suffix = total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : " MB";
        writeInstallStatus(globalThis.__frPaths, { phase: "download", message: `${label}下载中 ${mb}${suffix}` });
      }
    }
    await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    file.destroy();
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  if (received < 1_000_000) throw new Error(`${label}文件过小（${received} 字节），下载源可能返回了错误页`);
}

function extractZip(zipPath, destDir) {
  const attempts = [];
  if (process.platform === "win32") {
    const bsdtar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(bsdtar)) attempts.push({ exe: bsdtar, args: ["-xf", zipPath, "-C", destDir] });
    const quote = (value) => value.replace(/'/g, "''");
    attempts.push({
      exe: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(destDir)}' -Force`],
    });
  } else {
    attempts.push({ exe: "tar", args: ["-xf", zipPath, "-C", destDir] });
    attempts.push({ exe: "unzip", args: ["-o", "-q", zipPath, "-d", destDir] });
  }
  let lastError = null;
  for (const attempt of attempts) {
    const result = spawnSync(attempt.exe, attempt.args, { windowsHide: true, encoding: "utf8" });
    if (!result.error && result.status === 0) return;
    lastError = result.error || new Error(`${attempt.exe} 退出码 ${result.status}`);
  }
  throw new Error(`解压失败：${lastError?.message || "系统缺少可用的解压工具"}`);
}

function moveDirectory(source, target) {
  for (let index = 0; index < 5; index += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch {
      if (index === 4) break;
      spawnSync(process.execPath, ["-e", "setTimeout(()=>{},400)"], { windowsHide: true });
    }
  }
  fs.cpSync(source, target, { recursive: true });
  try { fs.rmSync(source, { recursive: true, force: true }); } catch { /* leftover is harmless */ }
}

async function installSource(paths, config) {
  const sourceDir = String(config.RUODAO_FLAGSHIP_SOURCE_DIR || "").trim();
  if (sourceDir) {
    if (!fs.existsSync(path.join(sourceDir, "package.json"))) throw new Error(`本地源码目录无效：${sourceDir}`);
    writeInstallStatus(paths, { phase: "extract", message: "正在复制本地源码…" });
    fs.rmSync(paths.appDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, paths.appDir, { recursive: true });
    return;
  }
  const sourceZip = String(config.RUODAO_FLAGSHIP_SOURCE_ZIP || "").trim();
  const zipPath = path.join(paths.cacheDir, "flagshiprouter-main.zip");
  fs.mkdirSync(paths.cacheDir, { recursive: true });
  if (sourceZip && fs.existsSync(sourceZip)) {
    fs.copyFileSync(sourceZip, zipPath);
  } else {
    const urls = [];
    if (sourceZip) urls.push(sourceZip);
    const mirror = String(config.RUODAO_FLAGSHIP_MIRROR || "").trim();
    if (mirror) urls.push(`${mirror.replace(/\/+$/, "")}/${SOURCE_ZIP}`);
    urls.push(SOURCE_ZIP, `https://gh-proxy.com/${SOURCE_ZIP}`, `https://ghfast.top/${SOURCE_ZIP}`, ARCHIVE_ZIP);
    let lastError = null;
    let downloaded = false;
    for (const url of [...new Set(urls)]) {
      try {
        await downloadTo(url, zipPath, "FlagshipRouter 源码");
        downloaded = true;
        break;
      } catch (error) {
        lastError = error;
        writeInstallStatus(paths, { phase: "download", message: `下载源失败，正在重试：${url}` });
      }
    }
    if (!downloaded) throw new Error(lastError?.message || "所有下载源都失败了，请检查网络或配置镜像");
  }
  const staging = path.join(paths.home, "staging");
  writeInstallStatus(paths, { phase: "extract", message: "正在解压源码…" });
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  extractZip(zipPath, staging);
  const inner = fs.readdirSync(staging).find((entry) => entry.startsWith("FlagshipRouter-"));
  if (!inner) throw new Error("压缩包结构不符合预期（未找到 FlagshipRouter 根目录）");
  fs.rmSync(paths.appDir, { recursive: true, force: true });
  moveDirectory(path.join(staging, inner), paths.appDir);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
}

function findNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.npm_execpath && /npm-cli\.js$/i.test(process.env.npm_execpath) ? process.env.npm_execpath : "",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function ensureNpm(paths) {
  const bundled = findNpmCli();
  if (bundled) return bundled;
  const npmRoot = path.join(paths.toolsDir, "npm");
  const npmCli = path.join(npmRoot, "package", "bin", "npm-cli.js");
  if (fs.existsSync(npmCli)) return npmCli;
  writeInstallStatus(paths, { phase: "install", message: "当前 Node 未自带 npm，正在下载 npm…" });
  const tarball = path.join(paths.cacheDir, "npm.tgz");
  await downloadTo(NPM_TARBALL, tarball, "npm");
  const staging = path.join(paths.toolsDir, "npm-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const result = spawnSync(process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar", ["-xzf", tarball, "-C", staging], { windowsHide: true, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const fallback = spawnSync("tar", ["-xzf", tarball, "-C", staging], { windowsHide: true, encoding: "utf8" });
    if (fallback.error || fallback.status !== 0) throw new Error("npm 解压失败，请安装自带 npm 的 Node.js 20.9+");
  }
  fs.rmSync(npmRoot, { recursive: true, force: true });
  fs.renameSync(staging, npmRoot);
  try { fs.rmSync(tarball, { force: true }); } catch { /* ignore */ }
  if (!fs.existsSync(npmCli)) throw new Error("npm 安装失败（未找到 npm-cli.js）");
  return npmCli;
}

/**
 * 上游把两个「构建期会被静态解析」的模块写在 optionalDependencies 里
 * （better-sqlite3 / @aws-sdk/credential-providers）。npm 省略 optional 时，
 * `next build` 会直接 module-not-found 失败 —— 这是历史上一键安装必败的根因。
 * 这里只保证模块可解析；better-sqlite3 不编译也能用（Node >= 22.5 走内置 node:sqlite，
 * 更老版本退 sql.js），所以补装时一律 --ignore-scripts，避免要求用户装 VS C++ 工具链。
 */
async function ensureBuildModules(paths, npmCli, installEnv) {
  const missing = missingBuildModules(paths.appDir);
  if (!missing.length) return;
  writeInstallStatus(paths, { phase: "install", message: `补齐构建必需模块：${missing.join("、")}` });
  await runLogged(paths, process.execPath, [
    npmCli, "install", ...missing,
    "--no-save", "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund",
  ], { ...installEnv, label: "补齐构建模块" });
}

async function installDependencies(paths, npmCli, installEnv) {
  const base = ["install", "--include=optional", "--no-audit", "--no-fund"];
  try {
    await runLogged(paths, process.execPath, [npmCli, ...base], installEnv);
  } catch (error) {
    // 原生模块的 prebuild / node-gyp 失败会让 install 整体失败（没有 C++ 工具链的 Windows 很常见）。
    // 运行期有多驱动兜底，构建期只需要能解析模块，因此跳过生命周期脚本重装。
    writeInstallStatus(paths, { phase: "install", message: `依赖安装脚本失败（${error.message}），跳过原生编译重试…` });
    await runLogged(paths, process.execPath, [npmCli, ...base, "--ignore-scripts"], { ...installEnv, label: "安装依赖（跳过原生编译）" });
  }
  await ensureBuildModules(paths, npmCli, installEnv);
}
function runLogged(paths, command, args, { cwd, env = process.env, label }) {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(paths.installLog, { flags: "a" });
    appendLog(paths.installLog, `\n$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let lastLine = "";
    let lastFlush = 0;
    const onData = (chunk) => {
      const text = String(chunk);
      log.write(text);
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      if (lines.length) lastLine = lines[lines.length - 1];
      if (Date.now() - lastFlush > 1500) {
        lastFlush = Date.now();
        writeInstallStatus(paths, { message: `${label}：${lastLine.slice(0, 180)}` });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      log.end();
      reject(error);
    });
    child.on("close", (code) => {
      log.end();
      if (code === 0) resolve();
      else reject(new Error(`${label}失败（退出码 ${code}）`));
    });
  });
}

async function stopGateway(paths, state, { silent = false } = {}) {
  const port = Number(state.port) || 0;
  const pid = Number(state.pid) || 0;
  if (pid) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
      else {
        try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
      }
    } catch { /* already gone */ }
  }
  if (port && await isUp(port)) await killPortOwner(port, { silent });
  state.pid = 0;
  writeState(paths, state);
}

async function killPortOwner(port, { silent = false } = {}) {
  try {
    if (process.platform === "win32") {
      const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true }).stdout || "";
      const line = netstat.split(/\r?\n/).find((row) => row.includes(`:${port} `) && /LISTENING/i.test(row));
      const pid = Number(line?.trim().split(/\s+/).pop() || 0);
      if (!pid) return;
      const tasks = spawnSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8", windowsHide: true }).stdout || "";
      if (!/node\.exe|electron\.exe/i.test(tasks)) throw new Error(`端口 ${port} 被其他程序占用（PID ${pid}），已停止自动清理`);
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
      return;
    }
    const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", windowsHide: true }).stdout || "";
    const pid = Number(lsof.trim().split(/\s+/)[0] || 0);
    if (!pid) return;
    const comm = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", windowsHide: true }).stdout || "";
    if (!/node/i.test(comm)) throw new Error(`端口 ${port} 被其他程序占用（PID ${pid}），已停止自动清理`);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!silent) throw error;
  }
}

async function waitUp(port, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isUp(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return false;
}

async function loginCookie(port, password) {
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  }, 15000);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`控制台登录失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 200)}` : ""}`);
  }
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const cookie = cookies.map((entry) => String(entry).split(";")[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("控制台登录成功但没有返回会话 Cookie");
  return cookie;
}

async function createApiKey(port, password) {
  const cookie = await loginCookie(port, password);
  const response = await fetchWithTimeout(`http://127.0.0.1:${port}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Ruodao Agent" }),
  }, 15000);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.key) throw new Error(`创建网关 API Key 失败（HTTP ${response.status}）${body?.error ? `：${body.error}` : ""}`);
  return { key: String(body.key), cookie };
}

async function ensureApiKey(paths, state, config, port) {
  const override = String(config.RUODAO_FLAGSHIP_API_KEY || "").trim();
  if (override && await verifyApiKey(port, override)) {
    if (state.apiKey !== override) {
      state.apiKey = override;
      writeState(paths, state);
    }
    return { key: override, cookie: "" };
  }
  if (state.apiKey && await verifyApiKey(port, state.apiKey)) return { key: state.apiKey, cookie: "" };
  if (!state.password) throw new Error("网关控制台密码缺失，无法自动创建 API Key");
  const created = await createApiKey(port, state.password);
  state.apiKey = created.key;
  writeState(paths, state);
  if (!await verifyApiKey(port, created.key)) throw new Error("API Key 已创建但校验失败");
  return created;
}

async function startGateway(paths, state, config) {
  if (!isInstalled(paths)) throw new Error("尚未安装网关本体，请先点击「一键安装」");
  const configuredPort = parsePort(config.RUODAO_FLAGSHIP_PORT, 0);
  let port = configuredPort || Number(state.port) || DEFAULT_PORT;
  if (!await isUp(port)) {
    if (!await canListen(port)) port = await findFreePort(port);
    if (port !== state.port) {
      state.port = port;
      writeState(paths, state);
    }
    const out = fs.openSync(paths.gatewayLog, "a");
    const env = buildGatewayEnv({
      paths,
      port,
      password: state.password,
      jwtSecret: state.jwtSecret,
      apiKeySecret: state.apiKeySecret,
      machineSalt: state.machineSalt,
    });
    const child = spawn(process.execPath, [path.join(paths.appDir, "custom-server.js"), "-p", String(port), "-H", "127.0.0.1"], {
      cwd: paths.appDir,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    fs.closeSync(out);
    state.pid = child.pid || 0;
    writeState(paths, state);
    if (!await waitUp(port)) {
      throw new Error(`网关 120 秒内未就绪，请查看日志：${paths.gatewayLog}`);
    }
  }
  const { key } = await ensureApiKey(paths, state, config, port);
  state.apiKey = key;
  writeState(paths, state);
  return await statusOf(paths, config);
}

async function installWorker(paths, config) {
  const startedAt = readInstallStatus(paths).startedAt || new Date().toISOString();
  writeInstallStatus(paths, { status: "running", phase: "download", message: "准备安装 FlagshipRouter…", startedAt, error: "" });
  try {
    assertNode();
    const state = ensureState(paths, config);
    await stopGateway(paths, state, { silent: true });
    if (!fs.existsSync(path.join(paths.appDir, "package.json"))) await installSource(paths, config);
    if (!isInstalled(paths)) {
      const npmCli = await ensureNpm(paths);
      const installEnv = {
        cwd: paths.appDir,
        env: { ...process.env, npm_config_cache: paths.cacheDir, npm_config_fund: "false", npm_config_audit: "false" },
        label: "安装依赖",
      };
      // 上次失败在 build 阶段时依赖已经装好了（>2 分钟），重试不该再跑一遍 npm install。
      // 只有依赖树缺失或构建必需模块不全时才重装，失败重试从几分钟降到几十秒。
      const depsReady = dependenciesReady(paths);
      if (depsReady) {
        writeInstallStatus(paths, { phase: "install", message: "依赖已就绪，跳过重复安装，直接重新构建…" });
      } else {
        writeInstallStatus(paths, { phase: "install", message: "正在安装依赖（首次约 2–5 分钟）…" });
        await installDependencies(paths, npmCli, installEnv);
      }
      writeInstallStatus(paths, { phase: "build", message: "正在构建网关（Next.js，约 2–6 分钟）…" });
      const buildEnv = {
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: "1",
          NODE_OPTIONS: `--max-old-space-size=6144 ${process.env.NODE_OPTIONS || ""}`.trim(),
          npm_config_cache: paths.cacheDir,
        },
        label: "构建网关",
      };
      try {
        await runLogged(paths, process.execPath, [npmCli, "run", "build"], { cwd: paths.appDir, ...buildEnv });
      } catch (error) {
        // package.json 的 build 走 webpack，个别环境（杀软/商店软件干扰文件扫描）会报 EPERM；
        // Turbopack 是 Next.js 官方构建器，绕过 webpack 文件扫描兜底。
        writeInstallStatus(paths, { phase: "build", message: `默认构建失败（${error.message}），改用 Turbopack 重试…` });
        await runLogged(paths, process.execPath, [npmCli, "exec", "next", "--", "build"], { cwd: paths.appDir, ...buildEnv });
      }
    }
    if (!isInstalled(paths)) throw new Error("安装结束但未找到 .next/BUILD_ID，构建可能未完成");
    ensureState(paths, config);
    writeInstallStatus(paths, {
      status: "succeeded",
      phase: "done",
      message: "安装完成，可以启动并接入 Agent",
      finishedAt: new Date().toISOString(),
      version: installedVersion(paths),
      error: "",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /Node\.js 20\.9/.test(message)
      ? "请安装 Node.js 22 LTS 后重试"
      : /下载|网络|HTTP|超时/.test(message)
        ? "检查网络或配置 RUODAO_FLAGSHIP_MIRROR / RUODAO_FLAGSHIP_SOURCE_ZIP 后重试"
        : `查看完整日志：${paths.installLog}`;
    appendLog(paths.installLog, `\n[install failed] ${message}\n`);
    writeInstallStatus(paths, { status: "failed", message: `安装失败：${message}`, error: message, hint, finishedAt: new Date().toISOString() });
    throw error;
  }
}

/* ── commands ────────────────────────────────────────────────────────── */

/**
 * 本体已在盘上（.next/BUILD_ID 存在）但状态文件仍是 failed —— 典型场景：上次构建失败后
 * 用户手动/重试补齐了依赖，或者重试成功但 worker 被杀。此时继续显示「安装失败」是假报错，
 * 这里把陈旧状态纠正为 succeeded，避免用户反复卸载重装。
 */
function reconcileInstallStatus(paths) {
  const current = readInstallStatus(paths);
  if (current.status !== "failed" || !isInstalled(paths)) return current;
  return writeInstallStatus(paths, {
    status: "succeeded",
    phase: "done",
    message: "安装完成，可以启动并接入 Agent",
    finishedAt: current.finishedAt || new Date().toISOString(),
    version: installedVersion(paths),
    error: "",
    hint: "",
  });
}

async function commandInstall(paths, config) {
  if (isInstalled(paths)) {
    ensureState(paths, config);
    return succeed({ installed: true, install: reconcileInstallStatus(paths), status: await statusOf(paths, config) });
  }
  const current = readInstallStatus(paths);
  if (current.status === "running") return succeed({ installed: false, install: current });
  const workerConfig = path.join(paths.home, "install-worker.json");
  fs.writeFileSync(workerConfig, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  writeInstallStatus(paths, {
    status: "running",
    phase: "starting",
    message: "安装任务已启动（后台执行，关闭界面不会中断）…",
    startedAt: new Date().toISOString(),
    error: "",
  });
  const out = fs.openSync(paths.installLog, "a");
  const child = spawn(process.execPath, [CLI_PATH, "install-worker"], {
    cwd: PLUGIN_DIR,
    env: { ...process.env, RUODAO_FLAGSHIP_HOME: paths.home, RUODAO_FLAGSHIP_CONFIG_FILE: workerConfig },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fs.closeSync(out);
  return succeed({ installed: false, install: readInstallStatus(paths) });
}

async function commandModels(paths, config) {
  const state = ensureState(paths, config);
  let status = await statusOf(paths, config);
  if (!status.running) {
    if (!status.installed) throw new Error("尚未安装网关，请先点击「一键安装」");
    status = await startGateway(paths, state, config);
  }
  const fresh = readState(paths);
  const apiKey = String(config.RUODAO_FLAGSHIP_API_KEY || fresh.apiKey || "");
  let modelsResponse = await fetchWithTimeout(`http://127.0.0.1:${fresh.port}/v1/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  }, 30000);
  if (modelsResponse.status === 401) {
    const created = await ensureApiKey(paths, fresh, config, fresh.port);
    modelsResponse = await fetchWithTimeout(`http://127.0.0.1:${fresh.port}/v1/models`, {
      headers: { authorization: `Bearer ${created.key}` },
    }, 30000);
  }
  const payload = await modelsResponse.json().catch(() => null);
  if (!modelsResponse.ok) {
    const message = payload?.error?.message || payload?.error || `HTTP ${modelsResponse.status}`;
    throw new Error(`拉取模型清单失败：${String(message).slice(0, 300)}`);
  }
  let catalog = [];
  try {
    const cookie = await loginCookie(fresh.port, fresh.password);
    const catalogResponse = await fetchWithTimeout(`http://127.0.0.1:${fresh.port}/api/models/catalog`, { headers: { cookie } }, 30000);
    const catalogPayload = await catalogResponse.json().catch(() => null);
    catalog = Array.isArray(catalogPayload?.models) ? catalogPayload.models : [];
  } catch {
    // Dashboard readiness is optional; /v1/models still gives usable ids.
  }
  const models = normalizeModels(payload?.data, catalog);
  return succeed({
    models,
    total: models.length,
    readyCount: models.filter((entry) => entry.ready === true).length,
    defaultSelected: defaultSelectedModelIds(models),
    status: await statusOf(paths, config),
  });
}

async function commandDoctor(paths, config) {
  const status = await statusOf(paths, config);
  const checks = {
    node: { ok: status.nodeSupported, message: `Node ${status.nodeVersion}${status.nodeSupported ? "" : "（需要 >= 20.9）"}` },
    installed: { ok: status.installed, message: status.installed ? `已安装 ${status.version}` : "未安装网关本体" },
    running: { ok: status.running, message: status.running ? `运行中 · 127.0.0.1:${status.port}` : "未运行" },
    apiKey: { ok: false, message: "未校验" },
    models: { ok: false, message: "未校验" },
  };
  let models = [];
  if (status.running) {
    const state = readState(paths);
    const key = String(config.RUODAO_FLAGSHIP_API_KEY || state.apiKey || "");
    const okKey = await verifyApiKey(status.port, key);
    checks.apiKey = { ok: okKey, message: okKey ? "API Key 可用" : "API Key 缺失或失效" };
    if (okKey) {
      try {
        const response = await fetchWithTimeout(`http://127.0.0.1:${status.port}/v1/models`, { headers: { authorization: `Bearer ${key}` } }, 20000);
        const body = await response.json().catch(() => null);
        models = normalizeModels(body?.data);
        checks.models = { ok: models.length > 0, message: `${models.length} 个文本模型` };
      } catch (error) {
        checks.models = { ok: false, message: String(error?.message || error) };
      }
    }
  }
  return succeed({ checks, status, modelCount: models.length });
}

async function main() {
  const command = process.argv[2] || "status";
  if (command === "install-worker") {
    const configFile = process.env.RUODAO_FLAGSHIP_CONFIG_FILE || "";
    const config = configFile ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};
    const paths = pathsFor(config);
    globalThis.__frPaths = paths;
    try { fs.rmSync(configFile, { force: true }); } catch { /* ignore */ }
    await installWorker(paths, config);
    return;
  }
  const payload = await readPayload();
  const config = configFrom(payload);
  const paths = pathsFor(config);
  globalThis.__frPaths = paths;
  if (command === "install") return await commandInstall(paths, config);
  if (command === "install-status") {
    return succeed({ install: reconcileInstallStatus(paths), installed: isInstalled(paths), status: await statusOf(paths, config) });
  }
  if (command === "status") return succeed({ status: await statusOf(paths, config) });
  if (command === "start") {
    assertNode();
    if (!isInstalled(paths)) throw new Error("尚未安装网关本体，请先点击「一键安装」");
    const state = ensureState(paths, config);
    return succeed({ status: await startGateway(paths, state, config) });
  }
  if (command === "stop") {
    const state = ensureState(paths, config);
    await stopGateway(paths, state);
    return succeed({ status: await statusOf(paths, config) });
  }
  if (command === "models") return await commandModels(paths, config);
  if (command === "doctor") return await commandDoctor(paths, config);
  if (command === "uninstall") {
    const state = ensureState(paths, config);
    await stopGateway(paths, state, { silent: true });
    fs.rmSync(paths.appDir, { recursive: true, force: true });
    try { fs.rmSync(paths.workerConfigFile, { force: true }); } catch { /* ignore */ }
    if (payload.purge === true) fs.rmSync(paths.home, { recursive: true, force: true });
    return succeed({ removed: true, purged: payload.purge === true, status: await statusOf(paths, config) });
  }
  if (command === "log") {
    return succeed({ installLog: readLogTail(paths.installLog, 20000), gatewayLog: readLogTail(paths.gatewayLog, 20000) });
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /Node\.js 20\.9/.test(message)
    ? "请安装 Node.js 22 LTS 后重试"
    : /尚未安装/.test(message)
      ? "先在插件工作台点击「一键安装」"
      : /120 秒内未就绪|网关/.test(message)
        ? `查看日志：${globalThis.__frPaths?.gatewayLog || "插件数据目录/gateway.log"}`
        : "";
  fail(message, hint);
});
