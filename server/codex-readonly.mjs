// An OS read-only sandbox does not restrict MCP servers or hosted app tools.
// Keep these overrides local to the delegated thread, then verify the runtime
// inventory before allowing the first inference turn.
export const CODEX_READONLY_FEATURES = Object.freeze([
  'apps', 'plugins', 'hooks', 'multi_agent', 'remote_plugin', 'skill_mcp_dependency_install',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'image_generation', 'code_mode_host',
]);

const MAX_PAGES = 20;
const MAX_ITEMS = 4000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function unverified() {
  const error = new Error('无法确认 Codex 只读智能体已关闭外部工具，已在模型运行前停止。请检查本机 Codex 的配置或版本。');
  error.code = 'RELAY_CODEX_READONLY_UNVERIFIED';
  return error;
}

export async function codexReadOnlyConfig(session, cwd) {
  try {
    const result = await session.request('config/read', { cwd, includeLayers: false });
    if (!record(result?.config) || !record(result.config.mcp_servers)) throw unverified();
    const entries = Object.entries(result.config.mcp_servers);
    if (entries.length > MAX_ITEMS || entries.some(([name, settings]) => !name || name.length > 1024 || !record(settings))) throw unverified();
    // An empty mcp_servers table is merged with inherited configuration; it
    // does not remove servers. Override each exact name, including dotted names.
    return {
      features: Object.fromEntries(CODEX_READONLY_FEATURES.map(name => [name, false])),
      mcp_servers: Object.fromEntries(entries.map(([name]) => [name, { enabled: false }])),
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw unverified();
  }
}

async function inventory(session, method, params, inspect) {
  let cursor;
  let count = 0;
  const seenCursors = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await session.request(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!record(result) || !Array.isArray(result.data)) throw unverified();
    count += result.data.length;
    if (count > MAX_ITEMS) throw unverified();
    for (const item of result.data) inspect(item);
    if (result.nextCursor === null) return;
    // Missing cursors are not proof that the effective inventory is complete.
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || seenCursors.has(result.nextCursor)) throw unverified();
    cursor = result.nextCursor;
    seenCursors.add(cursor);
  }
  throw unverified();
}

export async function verifyCodexReadOnly(session, threadId) {
  try {
    if (typeof threadId !== 'string' || !threadId) throw unverified();
    const found = new Set();
    await inventory(session, 'experimentalFeature/list', { threadId, limit: 200 }, item => {
      if (!record(item) || typeof item.name !== 'string' || typeof item.enabled !== 'boolean') throw unverified();
      if (!CODEX_READONLY_FEATURES.includes(item.name)) return;
      if (item.enabled || found.has(item.name)) throw unverified();
      found.add(item.name);
    });
    if (found.size !== CODEX_READONLY_FEATURES.length) throw unverified();
    await inventory(session, 'mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100 }, item => {
      if (!record(item) || typeof item.name !== 'string' || !item.name || item.runtimeStatus !== 'disabled'
        || !record(item.tools) || Object.keys(item.tools).length) throw unverified();
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // RPC failures can contain server URLs, environment variables, or other
    // private configuration. Report only the outcome of the isolation check.
    throw unverified();
  }
}
