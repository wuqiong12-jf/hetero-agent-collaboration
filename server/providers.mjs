import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { desktopCodexBinary } from './native-codex.mjs';

const BRIDGE = fileURLToPath(new URL('./harness_bridge.py', import.meta.url));
const INITIALIZE = { clientInfo: { name: 'relay_workbench', title: 'Relay Agent Workbench', version: '0.1.0' } };
const DEFAULT_TIMEOUT = 20 * 60 * 1000;

function aborted() {
  const error = new Error('任务已取消。');
  error.name = 'AbortError';
  return error;
}

// Prompts and API keys never become command-line arguments. Only trusted
// executable paths and fixed protocol flags pass through a Windows launcher.
export function processLaunch(executable, args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    if (/["\r\n&|<>^%!]/.test(executable) || args.some(arg => !/^[a-z0-9/_-]+$/i.test(arg))) {
      throw new Error('不安全的 Windows 启动路径；请将 RELAY_CODEX_BIN 指向 codex.exe。');
    }
    return { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], verbatim: true };
  }
  if (platform === 'win32' && extname(executable).toLowerCase() === '.ps1') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args] };
  }
  return { command: executable, args };
}

function findOnPath(name, env, platform, fileExists) {
  const variants = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, name] : [name];
  const pathEnv = env.PATH || env.Path || '';
  for (const directory of pathEnv.split(platform === 'win32' ? ';' : ':')) {
    if (!directory) continue;
    for (const variant of variants) {
      const candidate = join(directory.replace(/^"|"$/g, ''), variant);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function resolveCodex(env, platform, fileExists) {
  if (env.RELAY_CODEX_BIN) return env.RELAY_CODEX_BIN;
  if (platform === 'win32') {
    const native = desktopCodexBinary({env,platform,fileExists});
    if (native) return native;
  }
  return findOnPath('codex', env, platform, fileExists);
}

function resolvePython(env, platform, fileExists) {
  if (env.RELAY_PYTHON) return env.RELAY_PYTHON;
  const projectVenv = join(process.cwd(), '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fileExists(projectVenv)) return projectVenv;
  const bundled = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (fileExists(bundled)) return bundled;
  return findOnPath('python', env, platform, fileExists) || findOnPath('python3', env, platform, fileExists);
}

function cleanError(value, env) {
  let text = String(value?.message || value || '模型连接失败');
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ACCESS_TOKEN']) {
    if (env[name]) text = text.split(env[name]).join('[已隐藏凭证]');
  }
  return text.replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, '[已隐藏凭证]').slice(0, 1000);
}

/** Decode fragmented UTF-8 and bounded newline-delimited JSON, failing closed. */
export class JsonLines {
  constructor(onMessage, onError, maxBytes = 4 * 1024 * 1024) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.onMessage = onMessage;
    this.onError = onError;
    this.maxBytes = maxBytes;
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxBytes) return this.fail(new Error('模型协议帧超过大小限制。'));
      try { this.onMessage(JSON.parse(line)); } catch (error) { return this.fail(new Error(`模型协议错误：${error.message}`)); }
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) this.fail(new Error('模型协议帧超过大小限制。'));
  }
  fail(error) { this.failed = true; this.onError(error); }
}

function usageFromCodex(params) {
  const usage = params.tokenUsage?.total || params.tokenUsage?.last || params.usage || params.total;
  if (!usage || typeof usage !== 'object') return undefined;
  const result = {};
  if (Number.isFinite(usage.inputTokens)) result.inputTokens = usage.inputTokens;
  if (Number.isFinite(usage.outputTokens)) result.outputTokens = usage.outputTokens;
  if (Number.isFinite(usage.cachedInputTokens)) result.cachedInputTokens = usage.cachedInputTokens;
  return Object.keys(result).length ? result : undefined;
}

// UI labels such as “Codex 当前模型” describe the card, not a provider ID.
// Only a machine identifier may be forwarded to a provider; an explicit env
// setting remains authoritative and is validated by that provider.
function agentModelId(agent) {
  const candidate = agent.modelId || agent.model;
  return typeof candidate === 'string' && /^[a-z0-9][a-z0-9._:/-]*$/i.test(candidate) && candidate !== 'default' ? candidate : undefined;
}

function agentAccessMode(agent) {
  const value = agent.accessMode === undefined ? 'workspace-write' : agent.accessMode;
  if (!['read-only', 'workspace-write'].includes(value)) throw new Error('accessMode 必须是 read-only 或 workspace-write。');
  return value;
}

function requestedReasoningEffort(agent, env) {
  const configured = agent.reasoningEffort;
  const key = agent.provider === 'codex' ? 'RELAY_CODEX_REASONING_EFFORT' : 'RELAY_DEEPSEEK_REASONING_EFFORT';
  const value = configured == null || ['', 'auto', 'default'].includes(configured) ? env[key] : configured;
  if (value == null || ['', 'auto', 'default'].includes(value)) return undefined;
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error('思考程度必须使用模型目录中的有效标识。');
  return value;
}

function reasoningMetadata(entries, defaultEffort, env) {
  const supportedReasoningEfforts = [];
  for (const item of Array.isArray(entries) ? entries : []) {
    const effort = typeof item === 'string' ? item : item?.reasoningEffort;
    if (typeof effort !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(effort) || supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) continue;
    const description = typeof item?.description === 'string' ? cleanError(item.description, env).slice(0, 400) : undefined;
    supportedReasoningEfforts.push({ reasoningEffort: effort, ...(description ? { description } : {}) });
  }
  const validDefault = supportedReasoningEfforts.some(item => item.reasoningEffort === defaultEffort);
  return { supportedReasoningEfforts, reasoningEffortSupported: supportedReasoningEfforts.length > 0, ...(validDefault ? { defaultReasoningEffort: defaultEffort } : {}) };
}

function assertReasoningEffort(model, effort) {
  if (!effort) return;
  if (!model || !model.reasoningEffortSupported || !model.supportedReasoningEfforts?.some(option => option.reasoningEffort === effort)) {
    throw new Error(`当前模型不支持思考程度「${effort}」；请从该模型的有效目录选择或使用默认。`);
  }
}

function usageDifference(current, previous) {
  if (!current || !previous) return undefined;
  const result = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens']) {
    if (!Number.isFinite(current[key])) continue;
    const baseline = previous[key] || 0;
    if (current[key] < baseline) return undefined;
    result[key] = current[key] - baseline;
  }
  return Object.keys(result).length ? result : undefined;
}

export function createProviders(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const fileExists = options.existsSync || existsSync;
  const spawn = options.spawn || nodeSpawn;
  const fetchModels = options.fetch || globalThis.fetch;
  const codexBin = options.codexBin || resolveCodex(env, platform, fileExists);
  const pythonBin = options.pythonBin || resolvePython(env, platform, fileExists);
  const timeoutMs = options.timeoutMs || Number(env.RELAY_AGENT_TIMEOUT_MS) || DEFAULT_TIMEOUT;
  const probeTimeoutMs = options.probeTimeoutMs || 15_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs || 10_000;
  const signalProcess = options.signalProcess || ((pid, signal) => process.kill(pid, signal));
  const processLifetimes = new WeakMap();
  let capabilityCache;
  let capabilityCheckedAt = 0;
  let capabilityRequest;
  const codexUsageTotals = new Map();
  const modelCaches = new Map();
  const modelRequests = new Map();
  let harnessReasoningCache;

  function start(executable, args, cwd, extraEnv = {}) {
    const launch = processLaunch(executable, args, platform, env);
    const childEnv = { ...env, ...extraEnv };
    // Codex inherits its managed login, never an ambient paid API key.
    if (executable === codexBin) {
      delete childEnv.OPENAI_API_KEY;
      delete childEnv.DEEPSEEK_API_KEY;
      delete childEnv.ACCESS_TOKEN;
    } else if (executable === pythonBin) {
      delete childEnv.OPENAI_API_KEY;
      delete childEnv.ACCESS_TOKEN;
    }
    const child = spawn(launch.command, launch.args, { cwd, env: childEnv, windowsHide: true, windowsVerbatimArguments: launch.verbatim, detached: platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let resolveClosed;
    const lifetime = { closed: false, spawnFailed: false, closedPromise: new Promise(resolve => { resolveClosed = resolve; }) };
    processLifetimes.set(child, lifetime);
    child.once('error', () => { if (!Number.isInteger(child.pid)) lifetime.spawnFailed = true; });
    child.once('close', () => { lifetime.closed = true; resolveClosed(); });
    return child;
  }

  function cleanupError(detail) {
    const error = new Error(`模型进程清理尚未确认：${detail}。为防止旧进程继续访问工作目录，不能释放执行锁。`);
    error.name = 'ProcessCleanupError';
    error.cleanupConfirmed = false;
    return error;
  }

  // Unlike a signal-send acknowledgement, this resolves only after the root
  // close event AND complete process-tree termination have been confirmed.
  function reapModelProcess(child) {
    if (!child) return Promise.resolve();
    const lifetime = processLifetimes.get(child);
    if (!lifetime) return Promise.reject(cleanupError('无法追踪已启动进程'));
    return new Promise((resolveReap, rejectReap) => {
      let done = false;
      let treeConfirmed = false;
      let groupTimer;
      const finish = error => {
        if (done) return;
        if (!error && (!lifetime.closed || !treeConfirmed)) return;
        done = true;
        clearTimeout(timer); clearTimeout(groupTimer);
        if (error) rejectReap(error); else resolveReap();
      };
      const timer = setTimeout(() => finish(cleanupError('等待退出确认超时')), cleanupTimeoutMs);
      lifetime.closedPromise.then(() => finish());
      const hasPid = Number.isInteger(child.pid) && child.pid > 0;
      if (!hasPid) {
        // Node has no OS child on spawn failure. Injected fake transports own
        // no OS descendants and must still supply the root close event.
        if (!lifetime.spawnFailed && spawn === nodeSpawn) { finish(cleanupError('缺少有效进程标识')); return; }
        treeConfirmed = true;
        try { if (!lifetime.closed) child.kill(); } catch (error) { finish(cleanupError(cleanError(error, env))); }
        finish(); return;
      }
      if (platform === 'win32') {
        try {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
          killer.once('error', error => {
            try { child.kill(); } catch {}
            finish(cleanupError(`Windows 进程树终止失败：${cleanError(error, env)}`));
          });
          killer.once('close', code => {
            if (code !== 0) { try { child.kill(); } catch {} finish(cleanupError(`Windows taskkill 返回 ${code}`)); return; }
            treeConfirmed = true; finish();
          });
        } catch (error) { try { child.kill(); } catch {} finish(cleanupError(cleanError(error, env))); }
        return;
      }
      // Every real POSIX launch owns a detached process group. Kill the group,
      // then probe ESRCH; root exit alone does not prove descendants are gone.
      try { signalProcess(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') { finish(cleanupError(cleanError(error, env))); return; } }
      const checkGroup = () => {
        if (done) return;
        try { signalProcess(-child.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') { treeConfirmed = true; finish(); return; }
          finish(cleanupError(cleanError(error, env))); return;
        }
        groupTimer = setTimeout(checkGroup, 20);
      };
      checkGroup();
    });
  }

  function killTree(child) {
    if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
    // The Harness bridge has its own child runtime. Terminate its complete
    // process tree, otherwise an aborted API turn can keep consuming tokens.
    if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.on('error', () => { try { child.kill(); } catch {} });
      } catch { try { child.kill(); } catch {} }
    } else {
      const kill = signal => {
        try {
          if (Number.isInteger(child.pid) && child.pid > 0) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { try { child.kill(signal); } catch {} }
      };
      kill('SIGTERM');
      const force = setTimeout(() => kill('SIGKILL'), 1500);
      force.unref?.();
    }
  }

  function codexSession({ cwd, signal, onEvent = () => {}, maxTime = timeoutMs, strictCleanup = false }) {
    if (!codexBin) throw new Error('未找到 Codex CLI。安装并登录后，或设置 RELAY_CODEX_BIN 为 codex.exe 的路径。');
    if (signal?.aborted) throw aborted();
    const child = start(codexBin, ['app-server'], cwd);
    let nextId = 0;
    let closed = false;
    let stderr = '';
    let cleanupPromise;
    const pending = new Map();
    const listeners = new Set();
    function rejectAll(error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      for (const listener of listeners) listener(error);
    }
    function stop(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectAll(error || new Error('Codex 连接已关闭。'));
      if (strictCleanup) { cleanupPromise = reapModelProcess(child); cleanupPromise.catch(() => {}); }
      else killTree(child);
    }
    function write(message) {
      if (closed) throw new Error('Codex 连接已关闭。');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    function message(frame) {
      if (closed) return;
      if (frame && frame.method && frame.id !== undefined) {
        // No UI approval handler exists yet. Never turn an approval or an
        // unknown server-initiated request into implicit permission.
        const approval = /requestApproval$/i.test(frame.method);
        write(approval ? { id: frame.id, result: { decision: 'decline' } } : { id: frame.id, error: { code: -32601, message: 'Relay has no handler for this server request' } });
        stop(new Error(approval ? `Codex 操作需要审批，已拒绝：${frame.method}。` : `Codex 请求尚未接入：${frame.method}。`));
        return;
      }
      if (frame && frame.id !== undefined) {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(cleanError(frame.error, env)));
        else entry.resolve(frame.result);
        return;
      }
      if (frame?.method) onEvent(frame.method, frame.params || {});
    }
    const parser = new JsonLines(message, error => stop(error));
    const onAbort = () => stop(aborted());
    const timer = setTimeout(() => stop(new Error('Codex 任务连接超时，进程已停止。')), maxTime);
    child.stdout.on('data', chunk => parser.push(chunk));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', error => stop(new Error(cleanError(error, env))));
    child.on('error', error => stop(new Error(cleanError(error, env))));
    child.on('close', (code) => {
      if (!closed) stop(new Error(`Codex 提前退出 (${code})：${cleanError(stderr || '未返回完成事件', env)}`));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    return {
      request(method, params) {
        if (closed) return Promise.reject(new Error('Codex 连接已关闭。'));
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          try { write({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
        });
      },
      notify(method, params) { write({ method, ...(params ? { params } : {}) }); },
      onFailure(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      close() { stop(); return cleanupPromise || Promise.resolve(); },
    };
  }

  async function initialize(session) {
    await session.request('initialize', INITIALIZE);
    session.notify('initialized');
  }

  async function probeCodex() {
    if (!codexBin) return { available: false, cliFound: false, authStatus: 'unavailable', detail: '未检测到 Codex CLI；可设置 RELAY_CODEX_BIN。' };
    let session;
    try {
      session = codexSession({ cwd: process.cwd(), maxTime: probeTimeoutMs });
      await initialize(session);
      const account = await session.request('account/read', { refreshToken: false });
      const authType = account?.account?.type;
      if (authType === 'chatgpt') return { available: true, cliFound: true, authStatus: 'chatgpt-local', detail: '已检测本机 ChatGPT 登录；联网令牌有效性在执行时验证。' };
      if (authType === 'apiKey') return { available: false, cliFound: true, authStatus: 'api-key', detail: 'Codex 当前使用 API key。此工作台仅使用 ChatGPT 订阅，请在 CLI 中登录 ChatGPT。' };
      return { available: false, cliFound: true, authStatus: 'not-logged-in', detail: 'Codex CLI 可启动，尚未检测到受支持的 ChatGPT 登录。' };
    } catch (error) { return { available: false, cliFound: true, authStatus: 'unverified', detail: `Codex CLI 存在，登录状态未核实：${cleanError(error, env)}` }; }
    finally { session?.close(); }
  }

  function probeHarness() {
    if (!pythonBin) return Promise.resolve({ available: false, detail: '未找到 Python 3.10+；可设置 RELAY_PYTHON。' });
    return new Promise(resolveProbe => {
      let child;
      let ended = false;
      const finish = (details) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        killTree(child);
        const hasKey = Boolean(env.DEEPSEEK_API_KEY?.trim());
        const sdk = details.sdk === true && details.runtime === true;
        resolveProbe({ available: sdk && hasKey, sdkInstalled: sdk, keyConfigured: hasKey, reasoningEffortSupported: sdk && details.reasoningEffortSupported === true,
          reasoningEfforts: sdk && Array.isArray(details.reasoningEfforts) ? details.reasoningEfforts.filter(effort => ['off', 'low', 'high', 'max'].includes(effort)) : [],
          ...(typeof details.sdkVersion === 'string' ? { sdkVersion: details.sdkVersion } : {}),
          ...(typeof details.runtimeVersion === 'string' ? { runtimeVersion: details.runtimeVersion } : {}),
          model: env.RELAY_DEEPSEEK_MODEL || 'deepseek-flash', detail: !sdk ? `Harness SDK 尚未就绪：${details.detail || '在 RELAY_PYTHON 对应环境安装 deepseek-harness-sdk。'}` : !hasKey ? 'Harness SDK 已安装，缺少 DEEPSEEK_API_KEY。' : 'Harness SDK 与凭证已配置；连接在执行时验证，使用 workspace-write，拒绝权限升级。' });
      };
      const timer = setTimeout(() => finish({ detail: 'Python/SDK 检测超时。' }), probeTimeoutMs);
      try {
        child = start(pythonBin, ['-u', BRIDGE, '--probe'], dirname(BRIDGE), { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
        const parser = new JsonLines(frame => { if (frame.type === 'capabilities') finish(frame); }, () => finish({ detail: 'Python SDK 检测返回无效数据。' }));
        child.stdout.on('data', chunk => parser.push(chunk));
        child.stdin.on('error', () => finish({ detail: '无法与 Python SDK 通信。' }));
        child.on('error', error => finish({ detail: cleanError(error, env) }));
        child.on('close', () => finish({ detail: 'Python SDK 检测提前退出。' }));
        child.stdin.end();
      } catch (error) { finish({ detail: cleanError(error, env) }); }
    });
  }

  async function getCapabilities({ refresh = false } = {}) {
    if (!refresh && capabilityCache && Date.now() - capabilityCheckedAt < 30_000) return capabilityCache;
    if (capabilityRequest) return capabilityRequest;
    capabilityRequest = (async () => {
      const [codex, harness] = await Promise.all([probeCodex(), probeHarness()]);
      capabilityCache = { codex, harness, liveReady: codex.available && harness.available };
      capabilityCheckedAt = Date.now();
      return capabilityCache;
    })();
    try { return await capabilityRequest; } finally { capabilityRequest = undefined; }
  }

  async function readCodexModels(transport) {
    const models = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await transport.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const entry of result?.data || []) {
        const id = entry.model || entry.id;
        if (typeof id !== 'string' || !id.trim() || models.some(model => model.id === id)) continue;
        const defaultEffort = Array.isArray(entry.supportedReasoningEfforts) && entry.supportedReasoningEfforts.some(option => option?.reasoningEffort === env.RELAY_CODEX_REASONING_EFFORT)
          ? env.RELAY_CODEX_REASONING_EFFORT : entry.defaultReasoningEffort;
        const metadata = reasoningMetadata(entry.supportedReasoningEfforts, defaultEffort, env);
        models.push({ id, label: cleanError(entry.displayName || id, env), ...(entry.isDefault ? { isDefault: true } : {}), ...metadata,
          ...(!metadata.reasoningEffortSupported ? { reasoningEffortUnsupportedReason: '本机 Codex 模型目录未声明此模型的思考程度选项。' } : {}) });
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return models;
  }

  async function getCodexModels() {
    let transport;
    try {
      transport = codexSession({ cwd: process.cwd(), maxTime: probeTimeoutMs });
      await initialize(transport);
      const models = await readCodexModels(transport);
      return { models, available: true, catalogOnly: true, detail: '本机 Codex CLI 模型目录；实际模型访问权限在执行时验证。' };
    } catch (error) {
      return { models: [], available: false, catalogOnly: true, detail: `无法读取 Codex 模型目录：${cleanError(error, env)}` };
    } finally { transport?.close(); }
  }

  async function getDeepSeekModels() {
    if (!env.DEEPSEEK_API_KEY?.trim()) return { models: [], available: false, catalogOnly: true, detail: '缺少 DEEPSEEK_API_KEY，无法读取 DeepSeek 官方模型目录。' };
    if (typeof fetchModels !== 'function') return { models: [], available: false, catalogOnly: true, detail: '当前 Node.js 不支持读取 DeepSeek 官方模型目录。' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await fetchModels('https://api.deepseek.com/models', {
        method: 'GET', headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, Accept: 'application/json' },
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new Error(`DeepSeek 官方模型目录请求失败（HTTP ${response.status}）。`);
      const payload = await response.json();
      if (!Array.isArray(payload?.data)) throw new Error('DeepSeek 官方模型目录返回格式无效。');
      const models = [];
      const defaultModel = env.RELAY_DEEPSEEK_MODEL || 'deepseek-flash';
      if (!harnessReasoningCache || Date.now() - harnessReasoningCache.checkedAt > 30_000) {
        harnessReasoningCache = { result: await (options.probeHarness ? options.probeHarness() : probeHarness()), checkedAt: Date.now() };
      }
      const harness = harnessReasoningCache.result;
      for (const entry of payload.data) {
        const id = entry?.id;
        if (typeof id !== 'string' || id.length > 256 || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(id) || /^sk-/i.test(id) || id.includes(env.DEEPSEEK_API_KEY)) continue;
        if (models.some(model => model.id === id)) continue;
        const label = typeof entry.name === 'string' && entry.name.trim() ? cleanError(entry.name.trim(), env).slice(0, 120) : id;
        // Older official /models responses list IDs without extended metadata.
        // Only these models are documented with this exact effort contract:
        // https://api-docs.deepseek.com/api/list-models/
        const documentedEffort = entry.effort == null && ['deepseek-flash', 'deepseek-v4-pro'].includes(id)
          ? { supported_levels: ['low', 'high', 'max'], default_level: 'high' } : undefined;
        const effortInfo = entry.effort ?? documentedEffort;
        const levels = Array.isArray(effortInfo?.supported_levels) ? effortInfo.supported_levels : [];
        const validLevels = levels.filter(level => ['low', 'high', 'max'].includes(level) && harness.reasoningEfforts?.includes(level));
        const supports = harness.sdkInstalled && harness.reasoningEffortSupported && validLevels.length > 0;
        const efforts = supports ? [...(harness.reasoningEfforts.includes('off') ? [{ reasoningEffort: 'off', description: '关闭思考；Harness 将 thinking 设为 disabled。' }] : []),
          ...validLevels.map(reasoningEffort => ({ reasoningEffort }))] : [];
        const preferredDefault = efforts.some(option => option.reasoningEffort === env.RELAY_DEEPSEEK_REASONING_EFFORT)
          ? env.RELAY_DEEPSEEK_REASONING_EFFORT : effortInfo?.default_level;
        const metadata = reasoningMetadata(efforts, preferredDefault, env);
        models.push({ id, label, ...(id === defaultModel ? { isDefault: true } : {}), ...metadata,
          ...(supports ? { reasoningEffortSource: `${documentedEffort ? '官方 API 文档' : '官方 API 返回的模型能力'}与 Harness SDK ${harness.sdkVersion || '已安装版本'} 支持项的交集。` }
            : { reasoningEffortUnsupportedReason: !harness.reasoningEffortSupported ? '已安装的 Harness SDK 未声明 reasoning_effort 支持，或 SDK 尚不可用。' : '官方 API 未声明此模型与 Harness 匹配的思考程度。' }) });
      }
      if (!models.length) throw new Error('DeepSeek 官方模型目录没有可用的模型标识。');
      return { models, available: true, catalogOnly: true, detail: 'DeepSeek 官方 API 模型目录；实际模型推理仍使用 DeepSeek Harness。' };
    } catch (error) {
      const detail = controller.signal.aborted ? 'DeepSeek 官方模型目录请求超时。' : cleanError(error, env);
      return { models: [], available: false, catalogOnly: true, detail: `无法读取 DeepSeek 模型目录：${detail}` };
    } finally { clearTimeout(timer); }
  }

  async function getModels({ provider = 'codex', refresh = false } = {}) {
    if (!['codex', 'deepseek'].includes(provider)) return { models: [], available: false, catalogOnly: true, detail: '尚未配置这个提供方的模型目录。' };
    const cached = modelCaches.get(provider);
    if (!refresh && cached && Date.now() - cached.checkedAt < 30_000) return cached.result;
    if (modelRequests.has(provider)) return modelRequests.get(provider);
    const request = (async () => {
      const result = await (provider === 'codex' ? getCodexModels() : getDeepSeekModels());
      if (result.available) modelCaches.set(provider, { result, checkedAt: Date.now() });
      return result;
    })();
    modelRequests.set(provider, request);
    try { return await request; } finally { modelRequests.delete(provider); }
  }

  async function runCodex({ agent, prompt, onDelta, onSession, signal, workspace, session: previousSession }) {
    const effort = requestedReasoningEffort(agent, env);
    const accessMode = agentAccessMode(agent);
    let text = '';
    let latestUsage;
    let usageBaseline = previousSession ? codexUsageTotals.get(previousSession.id) : {};
    let turnRequested = false;
    let threadId = previousSession?.id;
    let reference = previousSession;
    let runError;
    const messages = new Map();
    const finalMessageIds = new Set();
    let finishTurn;
    let failTurn;
    const completed = new Promise((resolve, reject) => { finishTurn = resolve; failTurn = reject; });
    // A turn can fail while handshake requests are still pending.
    completed.catch(() => {});
    const session = codexSession({ cwd: workspace, signal, strictCleanup: true, onEvent(method, params) {
      if (threadId && params.threadId && params.threadId !== threadId) return;
      if (method === 'item/agentMessage/delta') {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        const id = params.itemId || 'default';
        messages.set(id, (messages.get(id) || '') + delta);
        if (delta) onDelta?.(delta, { type: 'text' });
      } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
        messages.set(params.item.id, params.item.text || '');
        if (params.item.phase === 'final_answer') finalMessageIds.add(params.item.id);
      } else if (method === 'thread/tokenUsage/updated') {
        latestUsage = usageFromCodex(params) || latestUsage;
        if (latestUsage && threadId) {
          if (!turnRequested) usageBaseline = { ...latestUsage };
          codexUsageTotals.set(threadId, { ...latestUsage });
          if (codexUsageTotals.size > 500) codexUsageTotals.delete(codexUsageTotals.keys().next().value);
        }
      } else if (method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(params.item?.type)) {
        const item = params.item;
        const label = item.command || item.tool || item.query || item.changes?.map(change => change.path).join(', ') || item.type;
        onDelta?.(`\n[工具：${String(label).slice(0, 800)}]\n`, { type: 'tool', method, itemType: item.type });
      } else if (method === 'item/commandExecution/outputDelta') {
        onDelta?.(params.delta || '', { type: 'tool', method });
      } else if (method === 'turn/completed') {
        if (params.turn?.status === 'completed') {
          const finals = (params.turn.items || []).filter(item => item.type === 'agentMessage');
          for (const item of finals) {
            messages.set(item.id, item.text || '');
            if (item.phase === 'final_answer') finalMessageIds.add(item.id);
          }
          text = finalMessageIds.size
            ? Array.from(finalMessageIds).map(id => messages.get(id)).filter(Boolean).join('\n\n')
            : Array.from(messages.values()).filter(Boolean).at(-1) || '';
          finishTurn({ text, usage: usageDifference(latestUsage, usageBaseline) });
        } else failTurn(new Error(cleanError(params.turn?.error || `Codex 任务未完成：${params.turn?.status}`, env)));
      }
    } });
    const offFailure = session.onFailure(failTurn);
    try {
      await initialize(session);
      const account = await session.request('account/read', { refreshToken: false });
      if (account?.account?.type !== 'chatgpt') throw new Error('此工作台要求本机 Codex 的 ChatGPT 登录；不使用 OpenAI API key。');
      const model = agentModelId(agent) || env.RELAY_CODEX_MODEL;
      const modelCatalog = effort ? await readCodexModels(session) : undefined;
      const startParams = { cwd: workspace, approvalPolicy: 'never', sandbox: accessMode, modelProvider: 'openai', ...(model && model !== 'default' ? { model } : {}) };
      const thread = previousSession
        ? await session.request('thread/resume', { threadId: previousSession.id, ...startParams })
        : await session.request('thread/start', startParams);
      threadId = thread?.thread?.id;
      if (!threadId) throw new Error('Codex 未返回有效 threadId。');
      if (previousSession && threadId !== previousSession.id) throw new Error('Codex 恢复返回了不同会话；为避免丢失上下文已停止。');
      reference = { provider: 'codex', id: threadId };
      onSession?.({ ...reference });
      const effectiveModel = model || thread.model || thread.thread?.model;
      const effortModel = modelCatalog?.find(entry => effectiveModel ? entry.id === effectiveModel : entry.isDefault);
      assertReasoningEffort(effortModel, effort);
      turnRequested = true;
      await session.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt }], cwd: workspace, approvalPolicy: 'never',
        sandboxPolicy: accessMode === 'read-only' ? { type: 'readOnly', networkAccess: false }
          : { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false },
        ...(effort ? { effort } : {}),
      });
      const result = await completed;
      if (!result.text?.trim()) throw new Error('Codex 完成事件未包含公开回复，不能送交监工验收。');
      return { ...result, session: reference };
    } catch (error) {
      runError = error;
      if (reference && error && typeof error === 'object') error.session = { ...reference };
      throw error;
    } finally {
      offFailure();
      try { await session.close(); if (runError) runError.cleanupConfirmed = true; }
      catch (error) { if (reference) error.session = { ...reference }; if (runError) error.cause = runError; throw error; }
    }
  }

  async function runHarness({ agent, prompt, onDelta, signal, workspace }) {
    if (!env.DEEPSEEK_API_KEY?.trim()) throw new Error('缺少 DEEPSEEK_API_KEY。请在启动服务器的环境中配置；不会回退到演示输出。');
    if (!pythonBin) throw new Error('未找到 Python；请设置 RELAY_PYTHON 并安装 deepseek-harness-sdk。');
    if (signal?.aborted) throw aborted();
    const reasoningEffort = requestedReasoningEffort(agent, env);
    const accessMode = agentAccessMode(agent);
    const model = agentModelId(agent) || env.RELAY_DEEPSEEK_MODEL || 'deepseek-flash';
    if (reasoningEffort) {
      const catalog = await getModels({ provider: 'deepseek' });
      assertReasoningEffort(catalog.models.find(entry => entry.id === model), reasoningEffort);
      if (signal?.aborted) throw aborted();
    }
    return new Promise((resolveRun, rejectRun) => {
      let child;
      let done = false;
      let stderr = '';
      const stop = async (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try {
          await reapModelProcess(child);
          if (error) { error.cleanupConfirmed = true; rejectRun(error); } else resolveRun(result);
        } catch (cleanup) { if (error) cleanup.cause = error; rejectRun(cleanup); }
      };
      const onAbort = () => stop(aborted());
      const timer = setTimeout(() => stop(new Error('DeepSeek Harness 任务超时，进程树已停止。')), timeoutMs);
      try {
        child = start(pythonBin, ['-u', BRIDGE], workspace, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', DSH_PERMISSION_MODE: accessMode, DSH_MAX_TOKENS_AS_SUCCESS: 'false' });
        const parser = new JsonLines(frame => {
          if (done) return;
          if (frame.type === 'delta') onDelta?.(frame.text || '', { type: 'text' });
          else if (frame.type === 'tool') onDelta?.(frame.text || '', { type: 'tool', method: frame.method });
          else if (frame.type === 'error') stop(new Error(cleanError(frame.message || 'Harness 执行失败。', env)));
          else if (frame.type === 'result') {
            if (frame.finishReason !== 'completed' || !frame.text?.trim()) stop(new Error(`Harness 未成功完成任务 (${frame.finishReason || 'unknown'})。`));
            else stop(null, { text: frame.text, ...(frame.usage ? { usage: frame.usage } : {}) });
          }
        }, error => stop(error));
        child.stdout.on('data', chunk => parser.push(chunk));
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.stdin.on('error', error => stop(new Error(cleanError(error, env))));
        child.on('error', error => stop(new Error(cleanError(error, env))));
        child.on('close', code => { if (!done) stop(new Error(`Harness 提前退出 (${code})：${cleanError(stderr || '未收到任务完成事件', env)}`)); });
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdin.write(JSON.stringify({
          prompt, workspace, model, accessMode, holdUntilClosed: true, ...(reasoningEffort ? { reasoningEffort } : {}),
          home: env.RELAY_HARNESS_HOME ? resolve(env.RELAY_HARNESS_HOME) : join(workspace, '.relay', 'harness-home'),
          maxTokens: Number(env.RELAY_DEEPSEEK_MAX_TOKENS) || 8192,
          timeoutSeconds: timeoutMs / 1000,
        }) + '\n');
      } catch (error) { stop(new Error(cleanError(error, env))); }
    });
  }

  async function runAgent({ agent, prompt, onDelta, onSession, signal, session, workspace = process.cwd() }) {
    if (!agent || !['codex', 'deepseek'].includes(agent.provider)) throw new Error('尚未配置这个模型的执行适配器。');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('智能体任务不能为空。');
    agent = { ...structuredClone(agent), accessMode: agentAccessMode(agent) };
    if (session && (session.provider !== agent.provider || typeof session.id !== 'string' || !session.id.trim() || session.id.length > 256)) throw new Error('原生会话引用无效或与当前模型提供方不符。');
    if (session && agent.provider === 'deepseek') throw new Error('当前 Harness SDK 适配器未接入原生会话恢复；请使用本侧聊天历史续聊。');
    const cwd = resolve(workspace);
    if (!isAbsolute(cwd) || !fileExists(cwd)) throw new Error('任务工作目录不存在。');
    return agent.provider === 'codex' ? runCodex({ agent, prompt, onDelta, onSession, signal, session, workspace: cwd }) : runHarness({ agent, prompt, onDelta, signal, workspace: cwd });
  }

  return { runAgent, getCapabilities, getModels };
}

const providers = createProviders();
export const runAgent = providers.runAgent;
export const getCapabilities = providers.getCapabilities;
export const getModels = providers.getModels;
