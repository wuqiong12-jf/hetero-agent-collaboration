import {realpathSync, statSync} from 'node:fs';
import {isAbsolute, normalize, resolve} from 'node:path';

export class WorkspaceBindingError extends Error {
  constructor(message, code = 'RELAY_WORKSPACE_INVALID') {
    super(message); this.name = 'WorkspaceBindingError'; this.code = code;
  }
}

export function canonicalWorkspace(directory) {
  if (typeof directory !== 'string' || !directory.trim() || directory.length > 4096 || /[\r\n\0]/.test(directory)) {
    throw new WorkspaceBindingError('工作目录必须是可读取的实际目录。未创建目录或修改协作快照。');
  }
  try {
    const actual = realpathSync.native(resolve(directory));
    if (!statSync(actual).isDirectory()) throw new Error('Not a directory');
    return actual;
  } catch {
    throw new WorkspaceBindingError('工作目录不存在、不是目录或无法读取。未加载任务或修改协作快照。');
  }
}

export function createWorkspaceBinding(directory) {
  return Object.freeze({version: 1, directory: canonicalWorkspace(directory)});
}

export function assertWorkspaceBinding(binding, actualDirectory) {
  if (binding === undefined) throw new WorkspaceBindingError(
    '旧协作快照尚未记录工作目录，已停止恢复且原文件保留。请先关闭旧服务，再使用目录迁移工具明确原任务目录。', 'RELAY_WORKSPACE_UNBOUND');
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || binding.version !== 1 ||
      Object.keys(binding).some(key => !['version', 'directory'].includes(key)) || typeof binding.directory !== 'string' ||
      !binding.directory || binding.directory.length > 4096 || /[\r\n\0]/.test(binding.directory) ||
      !isAbsolute(binding.directory) || normalize(resolve(binding.directory)) !== binding.directory) {
    throw new WorkspaceBindingError('协作快照的工作目录绑定无效，已停止恢复且原文件保留。');
  }
  if (binding.directory === actualDirectory) return;
  // Windows can have case-sensitive folders. A case-only alias needs actual
  // file identity; folding all paths could equate two different directories.
  if (process.platform === 'win32' && binding.directory.toLowerCase() === actualDirectory.toLowerCase()) {
    try {
      // Do not let a saved canonical path follow a newly redirected junction.
      if (realpathSync.native(binding.directory) === binding.directory) {
        const saved = statSync(binding.directory, {bigint: true});
        const current = statSync(actualDirectory, {bigint: true});
        if (saved.isDirectory() && current.isDirectory() && saved.ino > 0n && saved.ino === current.ino && saved.dev === current.dev) return;
      }
    } catch { /* A missing or redirected origin never authorizes another root. */ }
  }
  throw new WorkspaceBindingError(
    '保存的协作属于另一工作目录，未加载旧任务且原快照保留。请使用原目录恢复，或为新项目指定独立的状态文件。', 'RELAY_WORKSPACE_MISMATCH');
}
