// 与 config.jsonc 结构完全同构的类型模型（唯一事实来源 = config.jsonc 的
// animations / animationWeights / pets）。运行时（浏览器 PetCard / 桌面 sprite /
// 设置页）直接使用这套结构，不额外造转换后的类型。
//
// 本目录（src/shared）是浏览器 bundle 与桌面 shared-core（构建产物）共用的
// 纯逻辑层：无 React / DOM 依赖，两边各有一层薄壳做渲染与输入绑定。

/** 支持的角落 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * 宠物的显示位置（四个值，必填）：
 * - web     = 只显示在浏览器 overlay
 * - desktop = 只显示在桌面模式（Electron 透明窗）
 * - both    = 两者都显示
 * - none    = 都不显示（保留配置但不参与显示）
 */
export type PetDisplay = 'web' | 'desktop' | 'both' | 'none';

/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}

/** 移动池 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过） */
export interface Category {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

/** 事件动画：事件名 → 动画名数组（数组顺序 = 档位顺序；不进随机链，只由代码显式触发） */
export type Events = Record<string, string[]>;

/** 动画权重 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段 */
export interface Animations {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  events: Events;
}

/** 一只宠物（与 jsonc pets[i] 同形，position 嵌套）。
 *  可选段（animations / animationWeights / extra / assetRoot）为「文件定义宠物」专用：
 *  - animations / animationWeights 由 `pet/<名>-config.json` 提供：该宠物所属**种类**的
 *    完整独立动画池与权重（不回落全局 config.animations——文件宠物即完整声明，配置即种类）。
 *    一个 `-config.json` 的 pets 数组可放该种类的**任意多只实例**，共享同一动画池与素材目录。
 *  - extra: true 标记该宠物由 pet/ 目录文件定义：设置页不可编辑、保存时排除，
 *    由合并逻辑（src/shared 的 mergeExtraPets）统一打标，**永不出现在持久化配置里**。
 *  - assetRoot: 素材目录名（= 配置文件前缀 `<名>`，即 `pet/<名>-animation/`）；素材 URL
 *    用它而不是 id——多实例共享同一素材目录。main 等常规宠物缺省回落自身 id。
 */
export interface Pet {
  id: string;
  size: number;
  /** 是否启用余额功能：true=触发余额动画+显示余额气泡；false=该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  /** 是否启用碎碎念：true=按 eventsRefreshSec.whisper 周期生成一句话并播碎碎念动画；false=禁用。缺失默认 true（校验层补默认+警告） */
  whisperEnabled: boolean;
  /** 显示位置（web/desktop/both/none，必填）：缺失即配置错误，代码不做兜底 */
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
  animations?: Animations;
  animationWeights?: Weights;
  extra?: boolean;
  assetRoot?: string;
}

/** config.jsonc 全集——运行时直接使用（ANIM 即本类型） */
export interface ClientConfig {
  /** 系统通知总开关：true=对话完成/生成失败/输出截断/权限申请/用户选择时弹出系统通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新 + 动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}
