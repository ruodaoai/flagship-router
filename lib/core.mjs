import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

export const PLUGIN_ID = "flagship-router";
export const PROVIDER_ID = "flagship-router";
export const PROVIDER_NAME = "FlagshipRouter 免费模型";
export const DEFAULT_PORT = 20128;
export const MIN_NODE = [20, 9];
export const DEFAULT_CONTEXT_WINDOW = 128000;

export function isNodeVersionSupported(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map((part) => Number(part) || 0);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

export function resolveHome(config = {}, env = process.env) {
  return path.resolve(String(config.RUODAO_FLAGSHIP_HOME || env.RUODAO_FLAGSHIP_HOME || path.join(os.homedir(), ".ruodao-flagship-router")));
}

export function resolvePaths(home) {
  return {
    home,
    appDir: path.join(home, "app"),
    dataDir: path.join(home, "data"),
    cacheDir: path.join(home, "cache"),
    toolsDir: path.join(home, "tools"),
    stateFile: path.join(home, "state.json"),
    installStatusFile: path.join(home, "install-status.json"),
    installLog: path.join(home, "install.log"),
    gatewayLog: path.join(home, "gateway.log"),
    workerConfigFile: path.join(home, "install-worker.json"),
  };
}

/**
 * 上游把两个「构建期会被静态解析」的模块写在 optionalDependencies 里
 * （见 app/package.json）。npm 用 --omit=optional 安装时，next build 会
 * module-not-found 直接失败 —— 这是一键安装失败的真实原因，不要改回去。
 */
export const BUILD_REQUIRED_OPTIONAL = ["better-sqlite3", "@aws-sdk/credential-providers"];

/** 只判断模块目录是否可解析（原生二进制能否加载由运行期驱动兜底）。 */
export function moduleResolvable(appDir, id) {
  return fs.existsSync(path.join(appDir, "node_modules", ...String(id).split("/"), "package.json"));
}

/** 依赖是否已经装好：next 与构建必需 optional 模块都在，就没必要再跑 npm install。 */
export function dependenciesReady(paths) {
  if (!moduleResolvable(paths.appDir, "next")) return false;
  return missingBuildModules(paths.appDir).length === 0;
}
export function missingBuildModules(appDir) {
  return BUILD_REQUIRED_OPTIONAL.filter((id) => !moduleResolvable(appDir, id));
}
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function readState(paths) {
  return readJson(paths.stateFile, {});
}

export function writeState(paths, state) {
  writeJson(paths.stateFile, state);
}

export function readInstallStatus(paths) {
  return readJson(paths.installStatusFile, { status: "idle", phase: "", message: "", logTail: "" });
}

export function writeInstallStatus(paths, patch) {
  const previous = readInstallStatus(paths);
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
    logTail: patch.logTail ?? readLogTail(paths.installLog),
  };
  writeJson(paths.installStatusFile, next);
  return next;
}

export function readLogTail(file, limit = 5000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - limit);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function isInstalled(paths) {
  return fs.existsSync(path.join(paths.appDir, "package.json"))
    && fs.existsSync(path.join(paths.appDir, ".next", "BUILD_ID"));
}

export function installedVersion(paths) {
  return String(readJson(path.join(paths.appDir, "package.json"), {})?.version ?? "");
}

export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function newPassword() {
  return `ruodao-${crypto.randomBytes(6).toString("hex")}`;
}

export function parsePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

export async function findFreePort(start = DEFAULT_PORT) {
  for (let port = start; port < start + 80; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ port, host: "127.0.0.1" }, () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`端口 ${start}-${start + 79} 都被占用，请在插件配置里指定其他端口`);
}

const NON_TEXT_KINDS = new Set(["image", "tts", "stt", "speech", "embedding", "imageToText", "video", "music", "rerank", "moderation", "webFetch"]);

export function isTextLlmModel(entry) {
  const id = String(entry?.id ?? "").trim();
  if (!id) return false;
  const kind = String(entry?.kind ?? entry?.type ?? "").trim();
  if (kind && NON_TEXT_KINDS.has(kind)) return false;
  if (!kind && /(^|[-_/])(embed|embedding|whisper|tts|speech|dall-e|imagen|veo|sora|flux|stable-diffusion|midjourney)([-_/]|$)/i.test(id)) return false;
  return true;
}

export function contextWindowOf(entry = {}) {
  const candidates = [
    entry.context_window,
    entry.contextWindow,
    entry.context_length,
    entry.limits?.context_window,
    entry.caps?.contextWindow,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 1024) return Math.round(value);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * /v1/models only returns chat models, while /api/models/catalog additionally
 * carries readiness and per-model context windows. Merge both without trusting
 * either shape blindly.
 */
export function normalizeModels(v1Models, catalogModels = []) {
  const catalogById = new Map();
  for (const entry of Array.isArray(catalogModels) ? catalogModels : []) {
    const id = String(entry?.id ?? "").trim();
    if (id) catalogById.set(id, entry);
  }
  const seen = new Set();
  const models = [];
  for (const entry of Array.isArray(v1Models) ? v1Models : []) {
    const id = String(entry?.id ?? entry?.model ?? "").trim();
    if (!id || seen.has(id)) continue;
    const catalog = catalogById.get(id);
    if (!isTextLlmModel(catalog ?? entry)) continue;
    seen.add(id);
    const ready = typeof catalog?.ready === "boolean" ? catalog.ready : (typeof entry?.ready === "boolean" ? entry.ready : undefined);
    models.push({
      id,
      name: String(catalog?.name ?? entry?.name ?? id),
      contextWindow: contextWindowOf(catalog ?? entry),
      ready,
    });
  }
  models.sort((left, right) => {
    const readyOrder = Number(right.ready === true) - Number(left.ready === true);
    return readyOrder || left.id.localeCompare(right.id);
  });
  return models;
}

export function defaultSelectedModelIds(models, limit = 40) {
  const list = Array.isArray(models) ? models : [];
  const ready = list.filter((entry) => entry.ready === true).map((entry) => entry.id);
  return (ready.length ? ready : list.map((entry) => entry.id)).slice(0, limit);
}

export function buildProviderPayload({ port, apiKey = "", models = [], activeModel = "" }) {
  const list = (Array.isArray(models) ? models : [])
    .map((entry) => ({
      id: String(entry?.id ?? entry ?? "").trim(),
      contextWindow: contextWindowOf(entry),
      enabled: true,
    }))
    .filter((entry) => entry.id);
  if (!list.length) throw new Error("请先选择至少一个模型");
  const selected = String(activeModel || "").trim();
  const model = list.some((entry) => entry.id === selected) ? selected : list[0].id;
  const baseUrl = `http://127.0.0.1:${Number(port)}/v1`;
  return {
    provider: PROVIDER_ID,
    name: PROVIDER_NAME,
    model,
    baseUrl,
    contextWindow: list.find((entry) => entry.id === model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    wireApi: "responses",
    apiKey: String(apiKey ?? ""),
    models: list,
    enabled: true,
  };
}

export function buildGatewayEnv({ paths, port, password, jwtSecret, apiKeySecret, machineSalt, baseEnv = process.env }) {
  return {
    ...baseEnv,
    DATA_DIR: paths.dataDir,
    PORT: String(port),
    BASE_URL: `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    JWT_SECRET: jwtSecret,
    INITIAL_PASSWORD: password,
    API_KEY_SECRET: apiKeySecret,
    MACHINE_ID_SALT: machineSalt,
    REQUIRE_API_KEY: "true",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    AUTH_COOKIE_SECURE: "false",
    ENABLE_REQUEST_LOGS: "false",
  };
}
