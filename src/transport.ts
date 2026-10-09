import { App as McpApp } from '@modelcontextprotocol/ext-apps';
import type { State } from './types';

declare global {
  interface Window {
    __RELAY_NATIVE__?: boolean;
    __RELAY_VIEW__?: 'split' | 'deepseek';
  }
}

export const nativeHost = window.__RELAY_NATIVE__ === true;
if (nativeHost) document.documentElement.classList.add('mcp-host');
let application: McpApp | undefined;
let connecting: Promise<void> | undefined;

function applyView(view: unknown) {
  if (view !== 'split' && view !== 'deepseek') return;
  window.__RELAY_VIEW__ = view;
  window.dispatchEvent(new CustomEvent('relay-view', { detail: view }));
}

async function hostApp() {
  if (!application) {
    application = new McpApp({ name: '异智能体', version: '0.5.0' }, {}, { autoResize: true, strict: true });
    application.ontoolinput = params => applyView(params.arguments?.view);
    application.ontoolresult = result => applyView((result.structuredContent as { view?: unknown } | undefined)?.view);
    connecting = application.connect();
  }
  await connecting;
  if (!window.__RELAY_VIEW__ && application.getHostContext()?.displayMode !== 'fullscreen') applyView('deepseek');
  return application;
}

export async function requestJson<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  if (nativeHost) {
    const app = await hostApp();
    const result = await app.callServerTool({ name: 'relay_request', arguments: { route, method: body ? 'POST' : 'GET', ...(body ? { body } : {}) } });
    const response = result.structuredContent as { ok?: boolean; data?: T; error?: string } | undefined;
    if (result.isError || !response?.ok) throw new Error(response?.error || '本地智能体服务未连接');
    return response.data as T;
  }
  const response = await fetch(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成');
  return data as T;
}

export function watchState(onState: (state: State) => void, onConnection: (connected: boolean) => void, onError: (message: string) => void) {
  if (nativeHost) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval = 2000;
    const poll = async () => {
      try { const state = await requestJson<State>('/api/state'); interval = state.phase === 'running' || Object.values(state.chatSessions || {}).some(session => session.status === 'running') ? 1500 : 4000; if (!stopped) { onState(state); onConnection(true); } }
      catch (error) { if (!stopped) { onConnection(false); onError(error instanceof Error ? error.message : '本地服务未连接'); } }
      finally { if (!stopped) timer = setTimeout(poll, document.hidden ? Math.max(interval, 8000) : interval); }
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }
  const stream = new EventSource('/api/events');
  stream.addEventListener('snapshot', event => { try { onState(JSON.parse((event as MessageEvent).data)); onConnection(true); } catch { onError('无法读取对话状态'); } });
  stream.onopen = () => onConnection(true);
  stream.onerror = () => onConnection(false);
  return () => stream.close();
}
