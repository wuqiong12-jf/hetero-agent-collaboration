import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let cached;
export function desktopCodexBinary({ env = process.env, platform = process.platform, fileExists = existsSync, allowSystemDiscovery = fileExists === existsSync } = {}) {
  if (env.RELAY_CODEX_BIN) return env.RELAY_CODEX_BIN;
  if (platform !== 'win32') return undefined;
  if (cached && fileExists(cached)) return cached;
  try {
    if (!allowSystemDiscovery) throw new Error('System discovery disabled for injected filesystem');
    // Read only the current user's installed app location. Prefer its matching
    // CLI over an older separately installed npm/app-data binary.
    const directory = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
      "(Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore','pipe','ignore'] }).trim();
    if (directory) {
      const binary = join(directory, 'app', 'resources', 'codex.exe');
      if (fileExists(binary)) { cached = binary; return binary; }
    }
  } catch { /* Desktop is optional; normal CLI resolution still works. */ }
  const local = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const binary = join(local, 'OpenAI', 'Codex', 'bin', 'codex.exe');
  return fileExists(binary) ? binary : undefined;
}
