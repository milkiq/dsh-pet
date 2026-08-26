/**
 * 桌面 Helper 进程管理器 —— 拉起/守护 Electron 透明窗口进程。
 *
 * 架构：Helper 不通过 stdin 通信；渲染端经宿主暴露的 /dsh-pet-7340 HTTP 端点
 * 拉取配置/动画素材/余额/系统通知。这里只负责解析 Electron 可执行文件、
 * 以子进程方式拉起 electron-helper/main.js，并在异常退出时自动重启。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = resolve(here, '..');
export const defaultHelperMain = resolve(packageRoot, 'runtime', 'electron-helper', 'main.js');

interface HelperOptions {
  electronPath?: string;
  helperPath?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  restartDelayMs?: number;
}

type Logger = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

/**
 * 解析 Electron 可执行文件。
 * 优先级：
 *   1. 显式候选（用户配置）/ DSH_PET_ELECTRON_PATH 环境变量
 *   2. 本机已安装的 electron npm 包（require('electron') 返回二进制路径）
 *   3. 常见安装位置（~/.dsh/electron、npm 全局目录、Program Files）
 *   4. 都不存在时尝试 scripts/ensure-electron.mjs 自动下载
 */
export function resolveElectronPath(candidates: Array<string | undefined> = []): string | undefined {
  const seen = new Set<string>();
  const list: string[] = [];
  const push = (value: string | undefined | null) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };
  for (const value of candidates) push(value);
  if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && resolved) push(resolved);
  } catch {
    /* electron 未安装时跳过 */
  }
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const appData = process.env.APPDATA || join(userProfile, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || join(userProfile, 'AppData', 'Local');
  const localCandidates = [
    join(userProfile, '.dsh', 'electron', 'electron.exe'),
    join(appData, 'npm', 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(localAppData, 'Programs', 'Electron', 'electron.exe'),
    'C:/Program Files/Electron/electron.exe',
    'C:/Program Files (x86)/Electron/electron.exe',
  ];
  for (const candidate of localCandidates) push(candidate);
  if (process.env.ELECTRON_PATH) push(process.env.ELECTRON_PATH);
  if (!list.some((value) => existsSync(value))) {
    const ensured = ensureElectron();
    if (ensured) push(ensured);
  }
  return list.find((value) => existsSync(value));
}

/** 自动下载 Electron 到 $DSH_HOME/electron（scripts/ensure-electron.mjs）。 */
function ensureElectron(): string | undefined {
  const script = resolve(packageRoot, 'scripts', 'ensure-electron.mjs');
  if (!existsSync(script)) return undefined;
  console.log('[dsh-pet] Electron not found, running ensure-electron.mjs ...');
  const result = spawnSync(process.execPath, [script], {
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  if (result.status !== 0) return undefined;
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const exe = join(home, 'electron', 'electron.exe');
  return existsSync(exe) ? exe : undefined;
}

export function defaultLaunch(options: HelperOptions = {}): { command: string; args: string[] } {
  const electronPath = resolveElectronPath([options.electronPath]);
  if (!electronPath) {
    throw new Error('dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.');
  }
  const helperPath = options.helperPath || defaultHelperMain;
  return { command: electronPath, args: [helperPath] };
}

export class HelperProcess {
  declare readonly options: HelperOptions;
  declare readonly logger: Logger;
  declare private child?: import('node:child_process').ChildProcess;
  declare private stopping: boolean;
  declare private restartSuppressed: boolean;
  declare private restartTimer?: NodeJS.Timeout;

  constructor(options: HelperOptions = {}, logger: Logger = console) {
    this.options = options;
    this.logger = logger;
    this.child = undefined;
    this.stopping = false;
    this.restartSuppressed = false;
    this.restartTimer = undefined;
  }

  start(): import('node:child_process').ChildProcess | undefined {
    if (this.child || this.stopping || this.restartSuppressed) return this.child;
    const helperPath = this.options.helperPath || defaultHelperMain;
    const launch = this.options.command
      ? { command: this.options.command, args: this.options.args || [helperPath] }
      : defaultLaunch(this.options);
    const command = launch.command;
    const args = this.options.args || launch.args;

    const child = spawn(command, args, {
      cwd: this.options.cwd || packageRoot,
      env: { ...process.env, ...this.options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.once('error', (error) => {
      this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (!this.stopping && !this.restartSuppressed) {
        this.logger.warn?.(
          `dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`,
        );
        this.scheduleRestart();
      }
    });
    child.stdout.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) this.logger.debug?.(`[dsh-pet desktop helper] ${line}`);
    });
    child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
    });
    return child;
  }

  stop(reason = 'plugin-disposed'): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
    const child = this.child;
    if (!child) return;
    child.kill();
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || this.restartSuppressed) return;
    const delay = this.options.restartDelayMs ?? 750;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
}
