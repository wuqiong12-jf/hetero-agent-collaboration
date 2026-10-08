import { promises as filesystem } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

const CONFIG_KEYS = new Set(['RELAY_PYTHON', 'RELAY_DEEPSEEK_MODEL', 'RELAY_HARNESS_SOURCE']);
const DECRYPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$plain = $null
try {
  Add-Type -AssemblyName System.Security
  $cipher = [Console]::In.ReadToEnd().Trim()
  $bytes = [Convert]::FromBase64String($cipher)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $key = [System.Text.Encoding]::UTF8.GetString($plain)
  [Console]::Out.Write($key)
} catch {
  [Console]::Error.Write('DPAPI_DECRYPT_FAILED')
  exit 1
} finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
}
`;

async function optionalText(path, readFile, description) {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    // Neither file contents nor subprocess diagnostics may be reflected into logs.
    throw new Error(`无法读取${description}。请检查文件权限。`);
  }
}

function parseConfig(text, projectRoot) {
  let config;
  try { config = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
  catch { throw new Error('本地配置不是有效 JSON。'); }
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('本地配置必须是 JSON 对象。');
  const entries = [];
  for (const [key, value] of Object.entries(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error('本地配置包含不支持的字段；仅允许运行路径和模型信息。');
    if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('本地配置字段必须为非空单行字符串。');
    const clean = value.trim();
    if (key === 'RELAY_DEEPSEEK_MODEL') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(clean)) throw new Error('本地配置中的模型 ID 无效。');
      entries.push([key, clean]);
    } else entries.push([key, isAbsolute(clean) ? clean : resolve(projectRoot, clean)]);
  }
  return entries;
}

function decryptDpapi(cipher, { spawn = spawnProcess, timeoutMs = 10_000 } = {}) {
  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DECRYPT_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
    } catch { reject(new Error('无法启动本地密钥解密程序。')); return; }
    const chunks = []; let bytes = 0; let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolveResult(value);
    };
    const timer = setTimeout(() => {
      child.kill(); settle(new Error('本地密钥解密超时，请重试。'));
    }, timeoutMs);
    child.on('error', () => settle(new Error('无法启动本地密钥解密程序。')));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 16_384) { child.kill(); settle(new Error('本地密钥解密结果无效。')); return; }
      chunks.push(Buffer.from(chunk));
    });
    // Consume stderr without copying its contents into any exception or output.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => settle(new Error('本地密钥解密失败。请检查 Windows 用户与密钥文件。')));
    child.on('close', (code) => {
      if (code !== 0) { settle(new Error('本地密钥解密失败。请使用保存密钥的 Windows 用户。')); return; }
      settle(undefined, Buffer.concat(chunks).toString('utf8'));
    });
    // The ciphertext travels through stdin; neither ciphertext nor plaintext is
    // interpolated into shell code, process arguments, or user-visible output.
    child.stdin.end(cipher);
  });
}

/** Load project-local settings without logging credentials or making model calls.
 * Existing environment values, including explicitly empty values, take priority.
 * DPAPI format: Base64(ProtectedData.Protect(UTF8(key), null, CurrentUser)).
 */
export async function loadLocalConfig(projectRoot, {
  env = process.env,
  platform = process.platform,
  readFile = filesystem.readFile,
  decrypt = decryptDpapi,
  spawn = spawnProcess,
  timeoutMs = 10_000,
} = {}) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) throw new Error('项目根目录必须为绝对路径。');
  const root = resolve(projectRoot);
  const configText = await optionalText(join(root, '.relay', 'local-config.json'), readFile, '本地配置文件');
  const entries = configText === undefined ? [] : parseConfig(configText, root);
  let decryptedKey;
  if (env.DEEPSEEK_API_KEY === undefined) {
    const cipherText = await optionalText(join(root, '.relay', 'secrets', 'deepseek.dpapi'), readFile, '本地密钥文件');
    if (cipherText !== undefined) {
      if (platform !== 'win32') throw new Error('本地密钥受 Windows DPAPI 保护。请在原 Windows 用户下运行，或通过环境变量设置 DEEPSEEK_API_KEY。');
      const cipher = String(cipherText).replace(/^\uFEFF/, '').trim();
      if (!cipher || cipher.length > 65_536 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(cipher)) throw new Error('本地密钥文件格式无效。请重新保存密钥。');
      try { decryptedKey = await decrypt(cipher, { spawn, timeoutMs }); }
      catch { throw new Error('本地密钥解密失败。请检查文件是否由当前 Windows 用户保存。'); }
      if (typeof decryptedKey !== 'string' || !decryptedKey.trim() || decryptedKey.length > 16_384 || /[\r\n\0]/.test(decryptedKey)) throw new Error('本地密钥解密结果无效。');
      decryptedKey = decryptedKey.trim();
    }
  }
  // Validate and decrypt before making changes, so an invalid configuration
  // cannot leave a partially applied environment behind.
  for (const [key, value] of entries) if (env[key] === undefined) env[key] = value;
  const keyLoaded = decryptedKey !== undefined && env.DEEPSEEK_API_KEY === undefined;
  if (keyLoaded) env.DEEPSEEK_API_KEY = decryptedKey;
  return { configLoaded: configText !== undefined, keyLoaded };
}
