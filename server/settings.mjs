const ranges = { maxRetries: [0, 20], maxReviewRetries: [0, 10], maxSupervisorCalls: [1, 2000], maxWorkerCalls: [1, 2000], maxParallelReaders: [1, 4] };
const booleanKeys = new Set(['autoReview', 'autoDispatch']);
const providers = new Set(['codex', 'deepseek']);

class SettingsError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function leaves(patch, label) {
  if (!record(patch) || !Object.keys(patch).length) throw new SettingsError(`${label} 必须包含要修改的设置`);
  const values = new Map();
  for (const [key, value] of Object.entries(patch)) {
    if (booleanKeys.has(key)) {
      if (typeof value !== 'boolean') throw new SettingsError(`${key} 必须为布尔值`);
      values.set(key, value);
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max] = ranges[key];
      if (!Number.isInteger(value) || value < min || value > max) throw new SettingsError(`${key} 超出允许范围（${min}–${max}）`);
      values.set(key, value);
    } else if (key === 'maxProviderCalls') {
      if (!record(value) || !Object.keys(value).length) throw new SettingsError('maxProviderCalls 必须包含提供方预算');
      for (const [provider, limit] of Object.entries(value)) {
        if (!providers.has(provider) || !Number.isInteger(limit) || limit < 1 || limit > 2000) throw new SettingsError('提供方调用预算超出允许范围');
        values.set(`maxProviderCalls.${provider}`, limit);
      }
    } else throw new SettingsError(`不支持的设置字段：${key}`);
  }
  return values;
}
const currentValue = (settings, key) => key.startsWith('maxProviderCalls.') ? settings.maxProviderCalls?.[key.split('.')[1]] : settings[key];

// Compare only edited fields. Streaming updates and edits to other budgets may
// continue without invalidating this patch. Nothing mutates until all checks pass.
export function prepareSettings(current, payload) {
  const patch = leaves(payload.settings, 'settings');
  if (Object.hasOwn(payload, 'expectedSettings')) {
    const expected = leaves(payload.expectedSettings, 'expectedSettings');
    if (expected.size !== patch.size || [...patch.keys()].some(key => !expected.has(key))) throw new SettingsError('expectedSettings 必须与修改的设置字段完全一致');
    if ([...expected].some(([key, value]) => currentValue(current, key) !== value)) throw new SettingsError('这项设置已在其它窗口更新，请核对最新值后重新修改；未覆盖设置，也未启动模型。', 409);
  }
  const next = { ...current };
  for (const [key, value] of patch) {
    if (key.startsWith('maxProviderCalls.')) {
      next.maxProviderCalls = { ...next.maxProviderCalls, [key.split('.')[1]]: value };
    } else next[key] = value;
  }
  return next;
}
