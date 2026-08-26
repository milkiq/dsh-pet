/**
 * dsh-pet 宿主半侧（host half）—— 宠物插件的"后端"部分
 *
 * 职责：在 DSH Web 服务器上注册 `/dsh-pet-7340/` 前缀路由，把宠物动画 WebM / 配置 JSONC
 * 流式返回给浏览器与桌面模式。
 *
 * 路由：
 *   /dsh-pet-7340/thumb/<动画名>.webm  → $DSH_HOME/dsh-pet/main-animation/webm（用户目录，优先）→ 包内 assets/webm
 *   /dsh-pet-7340/config.jsonc        → 插件包内 assets/config.jsonc（默认值，只读）
 *   /dsh-pet-7340/config              → 用户覆盖配置（pets / animations / animationWeights / notificationsEnabled，JSON）
 *                                GET 读取、PUT 保存、DELETE 恢复默认（删除用户层）
 *   /dsh-pet-7340/config/meta         → 配置文件与素材目录路径（设置页展示用）
 *   /dsh-pet-7340/balance             → 余额查询（浏览器/桌面共用）
 *   /dsh-pet-7340/balance/trigger     → 手动触发计数（/balance 命令 +1，两边同样的轻量轮询）
 *
 * 系统通知不属于宠物行为、不在这里：它是"监测 DSH 事件 → 弹系统 toast"的独立能力，
 * 天然只跟 DSH 网页端走（浏览器半侧 notify.ts，经 connection 事件流 + Web Notification API）。
 *
 * 桌面模式（Electron 透明窗）没有独立配置文件：宠物显示在哪全部由 pets[].display 决定
 * （web=仅浏览器 / desktop=仅桌面 / both=两者 / none=都不显示）。display 是 pets 必填字段，
 * client 端 assertClientConfig 与 PUT 的 sanitizeUserConfig 都严格校验，缺失/非法即显式报错。
 *
 * 安全性：resolveAsset 做"防穿越"校验，保证路径仍在对应根目录内。
 *
 * TODO(类型)：peer 依赖类型包本地暂不可解析，ctx/req/res 暂用 any；
 *             依赖可解析后替换为 DSH 官方类型。
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { queryBalance } from './balance';
import { HelperProcess } from './helper-process';

/** 插件行 id（与 cordis.patch.yml 一致） */
export const name = 'pet';
/** 需要注入的服务：webServer（路由）+ agentDefaultModel（当前服务商）+ credentials（凭证）+ commands（/balance 斜杠命令） */
export const inject = ['webServer', 'agentDefaultModel', 'credentials', 'commands'];

/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 路由前缀 */
const ROUTE_PREFIX = '/dsh-pet-7340';

/** 不同扩展名对应的 Content-Type 映射 */
const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
 * @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined
 */
function resolveAsset(root: string, rel: string): string | undefined {
  if (rel.length === 0) return undefined;
  const candidate = normalize(join(root, rel));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return undefined;
  return candidate;
}

/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root: string, rel: string): string | undefined {
  const candidate = resolveAsset(root, rel);
  return candidate && existsSync(candidate) ? candidate : undefined;
}

/** 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。 */
async function sendFile(res: ServerResponse, file: string, contentType: string): Promise<void> {
  const { size } = await stat(file);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': size,
    'cache-control': 'public, max-age=3600',
  });
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** 剥除 JSONC 注释（行注释 // 与块注释）得到纯 JSON 字符串。
 *  host 侧自包含实现：绝不 import client/shared 侧模块——两个入口一旦共享模块，
 *  tsdown 会把 bundle 拆成多文件 chunk，而 DSH 只按单文件加载 /plugins/dsh-pet/client.js，会加载失败。
 *  （src/shared/config.ts 里的同一份实现在 client 半侧；此处是受该约束豁免的极小拷贝，见 shared/index.ts 注释） */
function stripJsonc(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();
}

/** 支持的角落白名单（与 client/shared 端一致） */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 显示位置白名单（与 shared/config.ts 一致；pets 必填字段，缺失即配置错误，不做兜底） */
const PET_DISPLAYS = ['web', 'desktop', 'both', 'none'] as const;
const PET_DISPLAY_SET: ReadonlySet<string> = new Set(PET_DISPLAYS);

/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display: unknown): boolean => display === 'desktop' || display === 'both';

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 收集请求体（文本） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve2, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve2(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 校验并归一化用户配置：只接受 { pets: [...] }，可选顶层 notificationsEnabled（布尔） */
function sanitizeUserConfig(raw: unknown): { pets: unknown[]; notificationsEnabled?: boolean } | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const arr = Array.isArray(o.pets) ? o.pets : null;
  if (!arr || !arr.length) return null;
  const out: unknown[] = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') return null;
    const pp = p as Record<string, unknown>;
    const id = String(pp.id ?? '');
    // 有意过滤文件名非法字符（Windows 保留符 + 控制字符），防止配置值逃逸 main-config.json 路径
    // eslint-disable-next-line no-control-regex
    if (!id || id.length > 64 || /[\\/:\x00-\x1f]/.test(id)) return null;
    const size = Number(pp.size);
    if (!Number.isFinite(size) || size <= 0) return null;
    const balanceEnabled = pp.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean') return null;
    const display = String(pp.display ?? '');
    if (!PET_DISPLAY_SET.has(display)) return null; // display 必填四值之一，缺失即配置错误
    const pos = pp.position && typeof pp.position === 'object' ? (pp.position as Record<string, unknown>) : {};
    const corner = String(pos.corner ?? '');
    if (!CORNERS.includes(corner)) return null;
    const marginX = Number(pos.marginX);
    const marginY = Number(pos.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
    out.push({ id, size, balanceEnabled, display, position: { corner, marginX, marginY } });
  }
  const ne = o.notificationsEnabled;
  if (ne !== undefined && typeof ne !== 'boolean') return null;
  const outConfig: { pets: unknown[]; notificationsEnabled?: boolean } = { pets: out };
  if (ne !== undefined) outConfig.notificationsEnabled = ne;
  return outConfig;
}

/** 宿主插件主体：注册 `/dsh-pet-7340` 前缀路由 + 系统通知事件队列。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（webServer/locale 等 service 无静态类型）
export function apply(ctx: any): void {
  // 用户数据根：配置与用户素材统一收敛于此（扩展包按 <插件id> 各自建目录）
  const userRoot = join(resolveDshHome(), 'dsh-pet');
  // 用户覆盖配置（pets / animations / animationWeights / notificationsEnabled 覆盖片段）
  const userConfigPath = join(userRoot, 'main-config.json');
  // 用户动画目录（thumb 播放时优先于包内素材；唯一格式 webm，素材放 main-animation/webm/）
  const thumbUserRoot = join(userRoot, 'main-animation');
  // 手动触发计数：/balance 命令 +1，两边（浏览器/桌面）同样的 1s 轮询检测变化后刷新余额（进程内内存态，重启归零）
  let balanceTriggerCount = 0;

  // 桌面宠物 = display 含 desktop 的第一只（桌面窗口会渲染全部 desktop/both 宠物，
  // 这里只需判定「是否存在」以决定是否拉起 Helper；大小由宠物自己的配置决定，宿主不再传）。
  const validatePets = (arr: unknown[]): Record<string, unknown>[] =>
    arr.map((p, index) => {
      const pet = p as Record<string, unknown> | null;
      const id = String(pet?.id ?? '');
      if (!id) throw new Error(`pets[${index}] 缺少 id`);
      const size = Number(pet?.size);
      if (!Number.isFinite(size) || size <= 0) throw new Error(`pet「${id}」size 非法`);
      if (typeof pet?.display !== 'string' || !PET_DISPLAY_SET.has(pet.display))
        throw new Error(`pet「${id}」缺少 display（需 web/desktop/both/none 之一）`);
      return pet as Record<string, unknown>;
    });

  /** 当前生效宠物列表：用户层（main-config.json）优先，否则包内 config.jsonc */
  const readEffectivePets = (): Record<string, unknown>[] => {
    if (existsSync(userConfigPath)) {
      try {
        const raw = JSON.parse(readFileSync(userConfigPath, 'utf8')) as Record<string, unknown>;
        if (Array.isArray(raw.pets) && raw.pets.length > 0) return validatePets(raw.pets);
      } catch (e) {
        ctx.logger?.warn?.(
          `dsh-pet: 用户配置非法（${e instanceof Error ? e.message : String(e)}），桌面模式回落默认配置`,
        );
      }
    }
    const cfgFile = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
    const raw = JSON.parse(stripJsonc(readFileSync(cfgFile, 'utf8'))) as Record<string, unknown>;
    if (!Array.isArray(raw.pets) || raw.pets.length === 0) throw new Error('config.jsonc 缺少 pets');
    return validatePets(raw.pets);
  };

  let hasDesktopPet = false;
  const refreshDesktop = (): void => {
    hasDesktopPet = false;
    try {
      hasDesktopPet = readEffectivePets().some((p) => isDesktopVisible(p.display));
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  refreshDesktop();

  /** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
  const desktopPetList = (): Array<{ id: string; size: number }> => {
    try {
      return readEffectivePets()
        .filter((p) => isDesktopVisible(p.display))
        .map((p) => ({ id: String(p.id), size: Number(p.size) }));
    } catch {
      return [];
    }
  };

  let helper: HelperProcess | undefined;
  let startRetryTimer: NodeJS.Timeout | undefined;

  /** 拉起桌面 Helper（Electron 为每只桌面宠物开一个局部小窗口）；
   *  Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay。 */
  const startHelper = (): void => {
    if (helper) return;
    if (!hasDesktopPet) return; // 无宠物显示在桌面（display 含 desktop/both）：不启动
    const port = typeof ctx.webServer?.port === 'number' ? ctx.webServer.port : 0;
    if (!port || port <= 0) {
      // webServer 可能尚未完成监听（OS 分配端口时 port 短暂为 0）：延迟重试。
      if (!startRetryTimer) {
        startRetryTimer = setTimeout(() => {
          startRetryTimer = undefined;
          startHelper();
        }, 500);
        startRetryTimer.unref?.();
      }
      return;
    }
    const origin = `http://127.0.0.1:${port}`;
    const configUrl = `${origin}${ROUTE_PREFIX}/config.jsonc`;
    helper = new HelperProcess(
      {
        env: {
          DSH_PET_CONFIG_URL: configUrl,
          DSH_PET_SCALE: '1',
          // 每只桌面宠物一个局部小窗口：透传宠物列表（[{id,size}]）
          DSH_PET_PETS: JSON.stringify(desktopPetList()),
        },
      },
      ctx.logger ?? console,
    );
    try {
      helper.start();
      ctx.logger?.info?.(`dsh-pet desktop helper started (config: ${configUrl})`);
    } catch (e) {
      ctx.logger?.warn?.(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
      helper = undefined;
    }
  };

  /** 停止桌面 Helper（保留配置，可再次拉起）。 */
  const stopHelper = (reason = 'settings-change'): void => {
    if (startRetryTimer) {
      clearTimeout(startRetryTimer);
      startRetryTimer = undefined;
    }
    helper?.stop(reason);
    helper = undefined;
  };

  /** 宠物配置（display 等）变更后：重解析桌面宠物并按需重启 Helper。 */
  const syncDesktop = (): void => {
    refreshDesktop();
    stopHelper('desktop-config-change');
    startHelper();
  };

  /** 包内动画素材根：唯一格式 webm。 */
  const assetRootFor = (): string => join(PACKAGE_ROOT, 'assets', 'webm');

  /** 用户动画根：唯一格式 webm（main-animation/webm）。 */
  const userRootFor = (): string => join(thumbUserRoot, 'webm');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));

          // 用户覆盖配置：/dsh-pet-7340/config（GET / PUT / DELETE）
          if (rest === 'config') {
            if (req.method === 'GET') {
              try {
                const raw = await readFile(userConfigPath, 'utf8');
                sendJson(res, 200, JSON.parse(raw));
              } catch {
                sendJson(res, 200, {}); // 无覆盖配置 → 空对象，client 回落默认
              }
              return;
            }
            if (req.method === 'PUT') {
              try {
                const body = await readBody(req);
                const parsed = JSON.parse(body);
                const clean = sanitizeUserConfig(parsed);
                if (!clean) {
                  sendJson(res, 400, {
                    error:
                      'invalid pet config: expected { pets:[{id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled 布尔）',
                  });
                  return;
                }
                await mkdir(userRoot, { recursive: true });
                await writeFile(userConfigPath, JSON.stringify(clean, null, 2), 'utf8');
                syncDesktop(); // display 等可能变化：重解析桌面宠物并重启 Helper
                sendJson(res, 200, { ok: true });
              } catch {
                sendJson(res, 400, { error: 'invalid JSON body' });
              }
              return;
            }
            if (req.method === 'DELETE') {
              try {
                await rm(userConfigPath, { force: true });
              } catch {
                /* 不存在也视为成功 */
              }
              syncDesktop(); // 恢复默认配置：重解析桌面宠物并重启 Helper
              sendJson(res, 200, { ok: true });
              return;
            }
            sendJson(res, 405, { error: 'method not allowed' });
            return;
          }

          // 配置文件路径（设置页「高级配置」展示用）
          if (rest === 'config/meta') {
            sendJson(res, 200, {
              user: userConfigPath,
              default: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
              animations: thumbUserRoot,
            });
            return;
          }

          // 余额查询（浏览器/桌面共用；结果由 host 侧完成全部抓取与校验，两端都不接触 key）
          if (rest === 'balance') {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'method not allowed' });
              return;
            }
            try {
              const sel = ctx.agentDefaultModel.currentSelection();
              const result = await queryBalance(sel.provider, async (ref) => {
                const rc = await ctx.credentials.resolve(credentialRef(ref));
                return rc?.value;
              });
              sendJson(res, 200, result);
            } catch (e) {
              // 意外异常（如注入服务缺失）：显式 500，不静默
              sendJson(res, 500, {
                ok: false,
                provider: 'unknown',
                reason: 'fetch-error',
                message: e instanceof Error ? e.message : String(e),
              });
            }
            return;
          }

          // 手动触发计数：/dsh-pet-7340/balance/trigger（no-cache，浏览器/桌面 1s 轻量轮询；/balance 命令写入）
          if (rest === 'balance/trigger') {
            const body = JSON.stringify({ count: balanceTriggerCount });
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache, no-store', // 触发计数必须实时，禁止任何缓存层介入
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return;
          }

          // 配置文件（JSONC）：/dsh-pet-7340/config.jsonc → 包内 assets/config.jsonc
          if (rest === 'config.jsonc') {
            const cfgFile = join(PACKAGE_ROOT, 'assets', 'config.jsonc');
            if (!existsSync(cfgFile)) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: config.jsonc not found');
              return;
            }
            await sendFile(res, cfgFile, MIME['.jsonc'] ?? 'application/octet-stream');
            return;
          }

          // 字体文件：/dsh-pet-7340/font/<file> → 包内 assets/fonts
          const [scope, ...nameParts] = rest.split('/');
          if (scope === 'font') {
            const fontRoot = join(PACKAGE_ROOT, 'assets', 'fonts');
            const fontFile = resolveExisting(fontRoot, nameParts.join('/'));
            if (fontFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: font not found');
              return;
            }
            const ext = fontFile.slice(fontFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, fontFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 通知图标：/dsh-pet-7340/pic/<file> → 包内 assets/pic（方形 png，系统通知 icon 用）
          if (scope === 'pic') {
            const picRoot = join(PACKAGE_ROOT, 'assets', 'pic');
            const picFile = resolveExisting(picRoot, nameParts.join('/'));
            if (picFile === undefined) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
              res.end('dsh-pet: pic not found');
              return;
            }
            const ext = picFile.slice(picFile.lastIndexOf('.')).toLowerCase();
            await sendFile(res, picFile, MIME[ext] ?? 'application/octet-stream');
            return;
          }

          // 动画文件：/dsh-pet-7340/thumb/<file>，唯一格式 webm
          // （assets/webm；用户动画目录 main-animation/webm 优先）。
          // Safari/HEVC(.mov) 兼容属 fork 定制（保留流水线 scripts/encode_hevc_alpha.sh）；
          // 需要者自行在本路由加回 .mov 扩展名分支——插件本体不发布、不支持 .mov。
          if (scope !== 'thumb') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: expected /dsh-pet-7340/thumb/<file>');
            return;
          }
          const fileName = nameParts.join('/');
          const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
          if (ext !== '.webm') {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: unsupported animation format (expected .webm)');
            return;
          }
          const file = resolveExisting(userRootFor(), fileName) ?? resolveExisting(assetRootFor(), fileName);
          if (file === undefined) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('dsh-pet: asset not found');
            return;
          }
          await sendFile(res, file, MIME[ext] ?? 'application/octet-stream');
        },
      }),
    'dsh-pet: /dsh-pet-7340 asset route',
  );

  // /balance 斜杠命令：递增触发计数 → 浏览器/桌面检测到变化后立即刷新余额并播动画（不进模型历史）
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'balance',
        description: '手动触发桌宠余额动画（立即显示余额气泡）',
        handler: () => {
          balanceTriggerCount += 1;
          return { kind: 'success', text: '已触发桌宠余额动画' };
        },
      }),
    'dsh-pet: /balance command',
  );

  // 系统通知不在此处：它独立于宠物（浏览器半侧 notify.ts 经 connection 事件流监听），
  // 宿主无需任何通知端点/监听。

  // 随插件生命周期清理：桌面 Helper 回收
  ctx.effect(() => () => {
    stopHelper('dsh-host-stop');
  });

  // 路由就绪后拉起桌面 Helper（Electron 缺失时仅告警，不影响 DSH 与浏览器 overlay）
  startHelper();
}
