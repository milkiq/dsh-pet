// 配置层：剥注释、校验 config.jsonc（src/shared 单一来源，浏览器与桌面共用）。
// 运行时（浏览器 PetCard / 桌面 sprite）直接使用与 jsonc 同构的 ClientConfig，
// 不做字段转换；缺失/非法一律视为配置错误（throw，由加载层显式报错）。
//
// 注意：宿主半侧（src/host）因 DSH 单文件加载约束必须自包含，这里不 import 本模块——
// 宿主侧只保留 stripJsonc 与 display 白名单两个极小拷贝（见 src/host/index.ts）。
import type { Animations, ClientConfig, Corner, Pet, PetDisplay, Weights } from './types';

/** 剥除 JSONC 注释（行注释 // 与块注释），得到纯 JSON 字符串 */
export const stripJsonc = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim();

/** 支持的角落白名单 */
export const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
/** corner 合法性检查用的 string 集合（Corner[] 的 includes 要求 Corner 参数，无法接收未知 string） */
const CORNER_SET: ReadonlySet<string> = new Set(CORNERS);

/** 显示位置白名单（四个值，必填） */
export const PET_DISPLAYS: PetDisplay[] = ['web', 'desktop', 'both', 'none'];
const PET_DISPLAY_SET: ReadonlySet<string> = new Set(PET_DISPLAYS);

/** 该宠物是否参与浏览器 overlay 渲染 */
export const isWebVisible = (display: PetDisplay): boolean => display === 'web' || display === 'both';
/** 该宠物是否参与桌面模式（Electron 透明窗）渲染 */
export const isDesktopVisible = (display: PetDisplay): boolean => display === 'desktop' || display === 'both';

/** ClientConfig 类型占位（data-less；加载后由 assertClientConfig 赋真实值） */
export const EMPTY_CONF: ClientConfig = {
  notificationsEnabled: true,
  pets: [],
  animations: {
    idle: [],
    turn: [],
    drag: [],
    clicks: [],
    moves: { default: {}, actions: [] },
    categories: [],
    events: {},
  },
  animationWeights: { idle: 0, turn: 0, move: 0 },
  eventsRefreshSec: {},
};

/** 校验 config.jsonc 解析结果并返回 ClientConfig；任一字段缺失/非法即视为配置错误抛出 */
export function assertClientConfig(raw: unknown): ClientConfig {
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: config 非对象');
  // raw 是 unknown 输入（jsonc 解析产物），按 Record 读取后逐字段手工校验，字段读写无法静态定型
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = raw as Record<string, any>;

  return {
    notificationsEnabled: assertNotificationsEnabled(cfg),
    pets: assertPetsBlock(cfg.pets),
    animations: assertAnimationsBlock(cfg.animations),
    animationWeights: assertWeightsBlock(cfg.animationWeights),
    eventsRefreshSec: assertEventsRefreshSec(cfg.eventsRefreshSec),
  };
}

/** 校验 pets 数组（主配置与文件宠物共用同一套规则）：非空、每只 id/size/balanceEnabled/display/position 完整合法、id 唯一 */
export function assertPetsBlock(petsArr: unknown): Pet[] {
  if (!Array.isArray(petsArr) || !petsArr.length) throw new Error('dsh-pet: 缺少 pets');
  const seen = new Set<string>();
  const pets: Pet[] = [];
  for (const p of petsArr) {
    const id = String(p?.id ?? '');
    if (!id || seen.has(id)) throw new Error('dsh-pet: pet id 非法或重复「' + id + '」');
    const size = Number(p?.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error('dsh-pet: pet「' + id + '」大小非法');
    const balanceEnabled = p?.balanceEnabled;
    if (typeof balanceEnabled !== 'boolean')
      throw new Error('dsh-pet: pet「' + id + '」缺少 balanceEnabled（需为布尔值 true/false）');
    const display = p?.display;
    if (display === undefined || display === null) {
      console.warn(`dsh-pet: pet「${id}」缺少 display，已按默认 both 处理`);
    } else if (typeof display !== 'string' || !PET_DISPLAY_SET.has(display)) {
      throw new Error('dsh-pet: pet「' + id + '」display 非法（需为 web/desktop/both/none 之一）');
    }
    const effectiveDisplay: PetDisplay = display === undefined || display === null ? 'both' : (display as PetDisplay);
    const corner = p?.position?.corner;
    if (typeof corner !== 'string' || !CORNER_SET.has(corner)) throw new Error('dsh-pet: pet「' + id + '」corner 非法');
    const marginX = Number(p?.position?.marginX);
    const marginY = Number(p?.position?.marginY);
    if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) throw new Error('dsh-pet: pet「' + id + '」边距非法');
    seen.add(id);
    pets.push({
      id,
      size,
      balanceEnabled,
      display: effectiveDisplay,
      position: { corner: corner as Corner, marginX, marginY },
    });
  }
  return pets;
}

/** 校验系统通知总开关（必填布尔值） */
function assertNotificationsEnabled(cfg: Record<string, unknown>): boolean {
  const notificationsEnabled = cfg.notificationsEnabled;
  if (typeof notificationsEnabled !== 'boolean')
    throw new Error('dsh-pet: 缺少 notificationsEnabled（需为布尔值 true/false）');
  return notificationsEnabled;
}

/** 校验 config.jsonc / 文件宠物配置里的 animations 段；缺失/非法即配置错误抛出（完整校验，无兜底） */
export function assertAnimationsBlock(a: unknown): Animations {
  if (!a || typeof a !== 'object') throw new Error('dsh-pet: 缺少 animations');
  const anims = a as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    if (!Array.isArray(anims[key])) throw new Error('dsh-pet: animations.' + key + ' 缺失');
  }
  const moves = anims.moves;
  if (
    !moves ||
    typeof moves !== 'object' ||
    typeof (moves as Record<string, unknown>).default !== 'object' ||
    (moves as Record<string, unknown>).default === null ||
    !Array.isArray((moves as Record<string, unknown>).actions)
  ) {
    throw new Error('dsh-pet: animations.moves 结构非法');
  }
  if (!Array.isArray(anims.categories)) throw new Error('dsh-pet: animations.categories 缺失');

  // ---- animations.events（事件动画：事件名 → 非空 string 数组，数组顺序即档位顺序）----
  // 事件功能已内置：events 段与 balance 事件均为必需，缺失即配置不完整，显式报错
  const ev = anims.events;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) throw new Error('dsh-pet: 缺少 animations.events');
  const evEntries = ev as Record<string, unknown>;
  for (const [eventName, pool] of Object.entries(evEntries)) {
    if (!Array.isArray(pool) || pool.length === 0) {
      throw new Error('dsh-pet: animations.events.' + eventName + ' 必须是非空动画名数组');
    }
    for (const name of pool) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('dsh-pet: animations.events.' + eventName + ' 含非法动画名');
      }
    }
  }
  const balance = evEntries.balance;
  if (!Array.isArray(balance) || balance.length === 0) {
    throw new Error('dsh-pet: animations.events.balance 缺失或为空（余额事件必备）');
  }
  return a as Animations;
}

/** 校验 animationWeights 段（idle/turn/move 三个非负数字） */
export function assertWeightsBlock(w: unknown): Weights {
  if (!w || typeof w !== 'object') throw new Error('dsh-pet: 缺少 animationWeights');
  const weights = w as Record<string, unknown>;
  for (const key of ['idle', 'turn', 'move']) {
    const v = Number(weights[key]);
    if (!Number.isFinite(v) || v < 0) throw new Error('dsh-pet: animationWeights.' + key + ' 非法');
    weights[key] = v;
  }
  return w as Weights;
}

/** 校验 eventsRefreshSec 段（事件名 → 正数秒数）；balance 周期必填 */
function assertEventsRefreshSec(raw: unknown): Record<string, number> {
  const ers = raw;
  if (!ers || typeof ers !== 'object' || Array.isArray(ers)) throw new Error('dsh-pet: 缺少 eventsRefreshSec');
  const cleaned: Record<string, number> = {};
  for (const [eventName, sec] of Object.entries(ers)) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error('dsh-pet: eventsRefreshSec.' + eventName + ' 非法（需为正数秒）');
    cleaned[eventName] = n;
  }
  const balanceSec = cleaned.balance;
  if (balanceSec === undefined) throw new Error('dsh-pet: eventsRefreshSec.balance 缺失（余额事件周期必备）');
  return cleaned;
}

/**
 * 文件定义宠物（`pet/<名>-config.json`）：与 config.jsonc 同构的**植物种类**配置。
 * 该文件定义一个「种类」：animations / animationWeights 为该种类独有的动画池（不回落全局），
 * 素材目录为 `pet/<名>-animation/`（`<名>` = 文件名前缀）；pets 数组可放该种类的**任意多只
 * 实例**（id 随意、互相唯一），每只共享动画池与素材，素材 URL 用资产根 `<名>` 而非实例 id。
 * 校验只覆盖「种类相关」字段（pets / animations / animationWeights，与主配置同一套规则）；
 * notificationsEnabled / eventsRefreshSec 是全局属性，不归宠物文件管——写了忽略、不写不报错。
 */
export interface ExtraPetFile {
  /** 该种类的所有实例（已打 assetRoot 标记） */
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
}

/**
 * 校验 `pet/<名>-config.json` 解析结果：pets（每只字段完整、id 唯一）+ animations +
 * animationWeights 按主配置同一套规则校验，然后按文件名前缀 `<名>` 给每只实例打 assetRoot
 * 标记；任一不符即 throw（调用方跳过该宠物并显式报错）。
 */
export function assertExtraPetFile(raw: unknown, assetRoot: string): ExtraPetFile {
  if (!raw || typeof raw !== 'object') throw new Error('dsh-pet: 额外宠物配置非对象');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = raw as Record<string, any>;
  return {
    pets: assertPetsBlock(cfg.pets).map((pet) => ({ ...pet, assetRoot })),
    animations: assertAnimationsBlock(cfg.animations),
    animationWeights: assertWeightsBlock(cfg.animationWeights),
  };
}

/** 合并文件定义宠物进宠物列表：追加 + 打 extra 标记（host 已保证 id 无冲突，这里只做拼接） */
export const mergeExtraPets = (base: Pet[], extra: Pet[]): Pet[] => [
  ...base,
  ...extra.map((e) => ({ ...e, extra: true as const })),
];

/** 合并宠物：用户层（{ pets }，与 jsonc 同构）全量替换默认；无用户层回落默认 */
export function resolvePets(defaults: Pet[], user: { pets?: Pet[] }): Pet[] {
  if (user && Array.isArray(user.pets)) return user.pets.length ? user.pets : defaults;
  return defaults;
}

/** 用户覆盖片段（与 jsonc 同构；高级用户直接编辑 main-config.json，缺省字段回落默认） */
export interface UserOverrides {
  pets?: Pet[];
  animations?: Animations;
  animationWeights?: Weights;
  eventsRefreshSec?: Record<string, number>;
  /** 系统通知总开关（可选）：用户层给出时优先于默认配置 */
  notificationsEnabled?: boolean;
}

/** 合并用户覆盖片段到完全体配置：pets / animations / animationWeights / eventsRefreshSec 有则整体替换，缺省回落默认 */
export function applyUserOverrides(base: ClientConfig, user: UserOverrides): ClientConfig {
  const next: ClientConfig = { ...base, pets: resolvePets(base.pets, user) };
  if (user.animations) next.animations = user.animations;
  if (user.animationWeights) next.animationWeights = user.animationWeights;
  if (user.eventsRefreshSec) next.eventsRefreshSec = user.eventsRefreshSec;
  // 系统通知总开关：用户层显式给出时优先，缺省回落默认配置
  if (user.notificationsEnabled !== undefined) next.notificationsEnabled = user.notificationsEnabled;
  return next;
}
