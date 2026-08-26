/**
 * dsh-pet desktop helper renderer —— 透明桌面窗口里的宠物本体（每只宠物一个 DOM sprite）。
 *
 * 与浏览器 overlay 严格对齐（宠物行为/文案完全一致，桌面的宠物内容不可能多于或少于浏览器）：
 *   - 纯逻辑（常量/选择器/移动几何/余额折算/配置校验）来自 shared-core.js
 *     （= src/shared 的构建产物，window.PetShared）——与浏览器 bundle 共用同一份源码；
 *   - 配置唯一来源 config.jsonc + 用户覆盖层（/config 合并），加载失败**大声报错**并显示红色错误条
 *     （每 5s 自动重试），绝无静默兜底池；
 *   - 动画素材经宿主 /dsh-pet-7340/thumb/<name>.webm（用户 main-animation 目录由宿主端优先）；
 *   - 功能集 = 浏览器 overlay：多开同屏（display∈{desktop,both} 全部渲染）、角落+边距定位、
 *     待机/转向/漫游/分类动作随机链、点击、拖拽（会话内位置保持，重启回角落）、
 *     余额事件动画 + 富余额气泡（每只宠物按 balanceEnabled 门控）。
 *   - 系统通知不是宠物行为（它独立于宠物：浏览器半侧 notify.ts 负责），桌面端不重复实现。
 *
 * 端点全部由 configUrl 推导：balance / balance/trigger / thumb / font。
 * 入口仅加载：shared-core.js（经典 script）→ renderer.js（本文件）。
 */
'use strict';

const S = window.PetShared;

const params = new URLSearchParams(location.search);
const CONFIG = {
  configUrl: params.get('configUrl') || 'http://127.0.0.1:3080/dsh-pet-7340/config.jsonc',
  scale: Number(params.get('scale') || '1'),
};
const ORIGIN = new URL(CONFIG.configUrl).origin;
const withSuffix = (suffix) => CONFIG.configUrl.replace(/config\.jsonc$/, suffix);
const BALANCE_URL = withSuffix('balance');
const TRIGGER_URL = withSuffix('balance/trigger');
const ASSET_BASE = withSuffix('thumb/');
const BUBBLE_DURATION_MS = 10 * 1000; // 余额气泡展示时长（与浏览器一致：定时自动消失，与动画解耦）

// ---------- 全局状态 ----------
const rootEl = document.getElementById('root');
const errorEl = document.getElementById('pet-error');
let config = null; // ClientConfig（通过 shared 的 assertClientConfig 校验）
let sprites = []; // PetSprite[]
let balance = null; // BalanceState（容器共享，一次拉取驱动所有启用余额的 sprite）
let balanceTick = 0;
let bootTimer = null;
let loopsStarted = false;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ---------- 调试钩子（冒烟自检/排障用；真实运行也可排查错误/配置/气泡） ----------
window.__dshPetDebug = {
  errors: [],
  configOk: false,
  spriteCount: 0,
  lastBubbleTitle: '',
  lastBalanceOk: null,
  bootAt: Date.now(),
};
window.addEventListener('error', (event) => {
  window.__dshPetDebug.errors.push(String(event.message || event.error));
});

// ---------- 配置（大声报错；失败 5s 重试） ----------
function showError(message) {
  console.error('[dsh-pet] ' + message);
  window.__dshPetDebug.configOk = false;
  errorEl.textContent = 'dsh-pet 配置错误：' + message;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
  errorEl.textContent = '';
}
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

async function loadConfig() {
  const res = await fetch(CONFIG.configUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`config http ${res.status}`);
  const base = S.assertClientConfig(JSON.parse(S.stripJsonc(await res.text())));
  // 用户覆盖层：pets / animations / animationWeights / eventsRefreshSec / notificationsEnabled
  let user = {};
  try {
    const r = await fetch(withSuffix('config'), { cache: 'no-store' });
    if (r.ok && r.status !== 204) user = await r.json().catch(() => ({}));
  } catch {
    /* 无用户层时忽略 */
  }
  // 合并后统一校验：用户层覆盖缺字段会静默丢配置，缺失即显式报错（与浏览器同一路径）
  return S.assertClientConfig(S.applyUserOverrides(base, user));
}

// ---------- 点击穿透（窗口级）：鼠标落在任一宠物/气泡外时穿透到下层应用 ----------
let lastMouse = { x: -1, y: -1 };
document.addEventListener('mousemove', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  updateClickThrough();
});
function updateClickThrough() {
  const anyInside = sprites.some((s) => {
    const r = s.hit.getBoundingClientRect();
    if (lastMouse.x >= r.left && lastMouse.x <= r.right && lastMouse.y >= r.top && lastMouse.y <= r.bottom) return true;
    if (s.bubble.classList.contains('is-on')) {
      const b = s.bubble.getBoundingClientRect();
      return lastMouse.x >= b.left && lastMouse.x <= b.right && lastMouse.y >= b.top && lastMouse.y <= b.bottom;
    }
    return false;
  });
  const anyDragging = sprites.some((s) => s.dragState.active || s.dragState.dragging);
  const ignore = !anyInside && !anyDragging;
  if (window.petBridge) window.petBridge.setIgnoreMouse(ignore);
}

// ---------- 单只宠物（行为与浏览器 PetCard 一致；纯逻辑来自 src/shared） ----------
class PetSprite {
  constructor(pet, cfg) {
    this.pet = pet; // 这只宠物的配置段（pets[i]）
    this.cfg = cfg; // 全量配置（ClientConfig）
    this.size = pet.size * CONFIG.scale;
    this.height = (this.size * 9) / 16;
    this.halfW = this.size / 2;
    this.halfH = this.height / 2;
    this.bottomPad = (this.size * (9 / 16) * (S.CANVAS_H - S.FEET_Y)) / S.CANVAS_H;

    // 播放状态（与浏览器同构）
    this.front = 0; // 0 = A, 1 = B
    this.pending = null;
    this.gen = 0;
    this.anim = cfg.animations.idle[0] ?? '';
    this.once = true;
    this.facing = 'left';
    // 交互/移动
    this.dragState = { active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 };
    this.justDragged = false;
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    this.customPos = null; // 拖拽后的会话内位置（{rx, ry} 比例）；restart 回角落
    // 余额气泡
    this.bubbleOn = false;
    this.bubbleTimer = null;
    this.balanceView = null;
    this.prevTick = 0;

    // DOM
    this.el = document.createElement('div');
    this.el.className = 'pet-sprite';
    this.el.style.setProperty('--pet-size', this.size + 'px');
    const stage = document.createElement('div');
    stage.className = 'pet-stage';
    stage.style.transform = 'translateY(' + this.bottomPad + 'px)';
    this.stage = stage;
    this.videoA = document.createElement('video');
    this.videoA.className = 'pet-video is-front';
    this.videoB = document.createElement('video');
    this.videoB.className = 'pet-video';
    for (const v of [this.videoA, this.videoB]) {
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.title = 'dsh-pet';
    }
    this.hit = document.createElement('div');
    this.hit.className = 'pet-hit';
    this.hit.style.left = (S.HIT_BOX.x0 / 640) * 100 + '%';
    this.hit.style.top = (S.HIT_BOX.y0 / 360) * 100 + '%';
    this.hit.style.width = ((S.HIT_BOX.x1 - S.HIT_BOX.x0) / 640) * 100 + '%';
    this.hit.style.height = ((S.HIT_BOX.y1 - S.HIT_BOX.y0) / 360) * 100 + '%';
    this.hit.title = 'dsh-pet';
    this.bubble = document.createElement('div');
    this.bubble.className = 'pet-bubble';

    stage.appendChild(this.videoA);
    stage.appendChild(this.videoB);
    stage.appendChild(this.hit);
    this.el.appendChild(this.bubble);
    this.el.appendChild(stage);
    rootEl.appendChild(this.el);
    this.position();

    // 事件（与浏览器同一套：pointerdown/move、click、window pointerup/cancel）
    const ac = new AbortController();
    this.ac = ac;
    this.hit.addEventListener('pointerdown', (e) => this.onPointerDown(e), { signal: ac.signal });
    this.hit.addEventListener('pointermove', (e) => this.onPointerMove(e), { signal: ac.signal });
    this.hit.addEventListener('click', () => this.onClick(), { signal: ac.signal });
    window.addEventListener('pointerup', (e) => this.onPointerUp(e), { signal: ac.signal });
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e), { signal: ac.signal });
    this.hit.addEventListener('lostpointercapture', (e) => this.onPointerUp(e), { signal: ac.signal });
  }

  dispose() {
    this.ac.abort();
    if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
    this.stopMove();
    this.el.remove();
  }

  // 角落/边距 → 位置；拖拽后按会话内位置（比例）并夹取在屏内
  position() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x;
    let y;
    if (this.customPos) {
      x = clamp(this.customPos.rx * W - this.halfW, 0, W - this.size);
      y = clamp(this.customPos.ry * H - this.halfH, 0, H - this.height);
    } else {
      const anchor = S.anchorPixel({
        corner: this.pet.position.corner,
        marginX: this.pet.position.marginX,
        marginY: this.pet.position.marginY,
        size: this.size,
        W,
        H,
      });
      x = anchor.x;
      y = anchor.y;
    }
    this.el.style.left = x + 'px';
    this.el.style.top = y + 'px';
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  }

  currentCenterX() {
    if (this.customPos) return this.customPos.rx * window.innerWidth;
    return this.el.getBoundingClientRect().left + this.halfW;
  }
  currentCenterY() {
    if (this.customPos) return this.customPos.ry * window.innerHeight;
    return this.el.getBoundingClientRect().top + this.halfH;
  }

  // 双缓冲切换（与浏览器同一套：前台 opacity 切换 + 降级视频清 handler 并停播，防残留 ended 雪崩）
  switchTo(next, nextOnce) {
    if (!next) return;
    const pending = this.pending;
    if (pending && pending.anim === next && pending.once === nextOnce) return;
    const gen = ++this.gen;
    this.pending = { anim: next, once: nextOnce, gen };
    const target = this.front === 0 ? this.videoB : this.videoA;
    const el = target;
    if (!el) return;
    el.src = ASSET_BASE + encodeURIComponent(next) + '.webm';
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = nextOnce ? () => this.handleEnded() : null;
    el.load();
    const onReady = () => {
      el.removeEventListener('loadeddata', onReady);
      if (this.pending && this.pending.gen !== gen) return;
      const old = this.front === 0 ? this.videoA : this.videoB;
      el.classList.add('is-front');
      if (old && old !== el) {
        old.classList.remove('is-front');
        old.onended = null;
        old.pause();
      }
      this.front = this.front === 0 ? 1 : 0;
      this.pending = null;
      el.style.transform = this.facing === 'right' ? 'scaleX(-1)' : '';
      el.play().catch(() => {});
      if (this.pendingMove) this.startMoveDrive(el);
    };
    el.addEventListener('loadeddata', onReady);
    if (el.readyState >= 2) onReady();
  }

  playOnce(name) {
    this.anim = name;
    this.once = true;
    this.switchTo(name, true);
  }

  // 动画链（与浏览器 pickNext 语义一致，纯逻辑在 shared）
  playIdle() {
    this.stopMove();
    const { animations, animationWeights } = this.cfg;
    const roll = Math.random();
    const k = S.rollKind(roll, animationWeights);
    let next;
    if (k === 'idle') {
      next = S.pick(animations.idle, this.anim);
    } else if (k === 'turn') {
      next = S.pick(animations.turn, this.anim);
    } else if (k === 'move') {
      const moved = this.tryMove();
      if (moved === false) {
        const act = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim);
        next = act.name;
      } else if (typeof moved === 'string') {
        next = moved;
      } else {
        // 已有一场移动进行中（占用）：与浏览器一致，重播当前动画，不另设（绝不重复加载不存在的动作）
        this.playOnce(this.anim);
        return;
      }
    } else {
      const act = S.pickCategoryAction(animations.categories, animations.idle, this.facing, this.anim);
      next = act.name;
    }
    this.playOnce(next);
  }

  handleEnded() {
    if (this.dragState.active) return;
    const { animations } = this.cfg;
    // 事件动画播完：回 idle（与 drag/clicks 同分支，不进随机链）；气泡由定时器自动消失，与动画解耦
    const isEvent = Object.values(animations.events ?? {}).some((pool) => pool.includes(this.anim));
    if (isEvent) {
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    if (animations.turn.includes(this.anim)) {
      const next = this.facing === 'left' ? 'right' : 'left';
      this.facing = next; // 立即同步：翻转后的 pickNext 用新朝向过滤 noMirror
    }
    if (animations.drag.includes(this.anim) || animations.clicks.includes(this.anim)) {
      if (animations.idle.length) this.playOnce(S.pick(animations.idle, this.anim));
      return;
    }
    this.playIdle();
  }

  // ---- 漫游（rAF 驱动，动画首尾各 leadSec/tailSec 秒原地不动；几何在 shared/planMove） ----
  tryMove() {
    if (this.moveRef !== null || this.pendingMove) return true;
    const moves = this.cfg.animations.moves;
    const actions = moves.actions;
    if (!actions.length) return false;
    const chosen = actions[Math.floor(Math.random() * actions.length)];
    const mp = Object.assign({}, moves.default, chosen.params || {});
    const dir = (this.facing === 'right') !== this.cfg.animations.turn.includes(this.anim) ? 1 : -1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const distScale = this.size / S.PET_REF_WIDTH;
    const plan = S.planMove({
      cx: this.currentCenterX(),
      cy: this.currentCenterY(),
      W,
      H,
      dir,
      minDist: mp.minDist * distScale,
      maxDist: mp.maxDist * distScale,
      margin: mp.margin,
      halfW: this.halfW,
    });
    if (!plan) return false;
    this.pendingMove = { ...plan, dir, leadSec: mp.leadSec, tailSec: mp.tailSec };
    this.anim = chosen.name;
    this.once = true;
    this.switchTo(chosen.name, true);
    return chosen.name;
  }

  startMoveDrive(el) {
    const pm = this.pendingMove;
    if (!pm || this.moveRef !== null) return;
    this.pendingMove = null;
    const { startRatio, startYRatio, targetRatio, dir, totalRatio, leadSec, tailSec } = pm;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
    const travelWindow = Math.max(0.1, duration - leadSec - tailSec);
    const token = ++this.moveToken;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const step = () => {
      if (this.moveToken !== token) return;
      const t = el.currentTime || 0;
      let ratioX;
      if (t <= leadSec) ratioX = startRatio;
      else if (t >= duration - tailSec) ratioX = targetRatio;
      else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
      const px = ratioX * W;
      const py = startYRatio * H;
      this.el.style.left = px - this.halfW + 'px';
      this.el.style.top = py - this.halfH + 'px';
      this.el.style.right = 'auto';
      this.el.style.bottom = 'auto';
      if (t < duration - tailSec) {
        this.moveRef = requestAnimationFrame(step);
      } else {
        this.moveRef = null;
        this.customPos = { rx: targetRatio, ry: startYRatio };
      }
    };
    this.moveRef = requestAnimationFrame(step);
  }

  stopMove() {
    this.pendingMove = null;
    this.moveToken++;
    if (this.moveRef !== null) {
      cancelAnimationFrame(this.moveRef);
      this.moveRef = null;
    }
  }

  // ---- 点击 vs 拖拽（与浏览器一致：拖拽阈值、抓取偏移、释放接循环待机、会话内位置保持） ----
  onPointerDown(e) {
    this.hit.classList.add('dragging');
    this.stopMove();
    try {
      this.hit.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略捕获失败 */
    }
    const rect = this.el.getBoundingClientRect();
    const offX = e.clientX - (rect.left + rect.width / 2);
    const offY = e.clientY - (rect.top + rect.height / 2);
    this.dragState = { active: true, dragging: false, sx: e.clientX, sy: e.clientY, offX, offY };
    if (window.petBridge) window.petBridge.setIgnoreMouse(false);
    // 注意：舞台「拍平」（去掉 translateY(bottomPad)）不能在这里做——
    // 纯点击（按下即松开）会让人物瞬移上移再落下。与浏览器一致：只有拖拽超过阈值才拍平。
  }

  onPointerMove(e) {
    const d = this.dragState;
    if (!d.active) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < S.DRAG_THRESHOLD) return;
      d.dragging = true;
      // 真正开始拖拽才把舞台拍平（人物随光标拿起；与浏览器 dragging 语义一致）
      this.stage.style.transform = 'none';
      if (this.cfg.animations.drag.length) {
        this.playOnce(S.pick(this.cfg.animations.drag));
      }
    }
    this.el.style.left = e.clientX - d.offX - this.halfW + 'px';
    this.el.style.top = e.clientY - d.offY - this.halfH + 'px';
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  }

  onPointerUp(e) {
    const d = this.dragState;
    const wasDragging = d.dragging;
    d.active = false;
    d.dragging = false;
    this.hit.classList.remove('dragging');
    // lostpointercapture 的 event 可能没有 clientX（pointercancel 同理）：fallback 到当前 DOM 位置
    const cx = e && Number.isFinite(e.clientX) ? e.clientX : this.el.getBoundingClientRect().left + this.halfW;
    const cy = e && Number.isFinite(e.clientY) ? e.clientY : this.el.getBoundingClientRect().top + this.halfH;
    this.stage.style.transform = 'translateY(' + this.bottomPad + 'px)';
    if (wasDragging) {
      this.justDragged = true;
      setTimeout(() => {
        this.justDragged = false;
      }, 100);
      this.customPos = { rx: (cx - d.offX) / window.innerWidth, ry: (cy - d.offY) / window.innerHeight };
      // 释放后接一段循环待机（与浏览器一致），再回随机链
      if (this.cfg.animations.idle.length) {
        const name = S.pick(this.cfg.animations.idle, this.anim);
        this.anim = name;
        this.once = false;
        this.switchTo(name, false);
      }
      this.position();
      updateClickThrough();
    }
  }

  onClick() {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged) return;
    this.stopMove();
    if (!this.cfg.animations.clicks.length) return;
    this.playOnce(S.pick(this.cfg.animations.clicks));
  }

  // ---- 余额事件（每只宠物按 balanceEnabled 门控；档位与气泡内容来自 shared） ----
  onBalanceTick(state, tick) {
    if (!this.pet.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫（与浏览器一致）
    if (tick === 0 || tick === this.prevTick) return;
    this.prevTick = tick;
    if (!state || !state.ok) return;
    const p = S.balancePercent(state);
    if (p === undefined) return; // 当前数据源没有百分比语义：不触发档位动画
    const pool = this.cfg.animations.events?.balance;
    if (!pool || pool.length === 0) {
      console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
      return;
    }
    const idx = S.balanceEventIndex(p);
    const name = pool[idx];
    if (!name) {
      console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
      return;
    }
    this.stopMove();
    this.bubbleOn = true;
    this.balanceView = S.balanceBubbleView(state);
    this.renderBubble();
    // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
    if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => {
      this.bubbleOn = false;
      this.renderBubble();
    }, BUBBLE_DURATION_MS);
    this.playOnce(name);
  }

  renderBubble() {
    if (!this.bubbleOn || !this.balanceView) {
      this.bubble.classList.remove('is-on');
      window.__dshPetDebug.lastBubbleTitle = '';
      return;
    }
    this.bubble.innerHTML = '';
    const rows = this.balanceView;
    const hasTier = rows.some((r) => r.role === 'tier');
    if (hasTier) {
      // deepseek 余额单行：余额（峰/谷）¥x — 档位字着色
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      for (const r of rows) {
        const span = document.createElement('span');
        if (r.role === 'tier') span.className = 'pet-bub-tier pet-bub-tier-' + r.tier;
        span.textContent = r.text;
        line.appendChild(span);
      }
      this.bubble.appendChild(line);
    } else {
      for (const r of rows) {
        const div = document.createElement('div');
        if (r.role === 'error') div.className = 'pet-bub-err';
        else if (r.role === 'sub') div.className = 'pet-bub-row pet-bub-sub';
        else div.className = 'pet-bub-row';
        div.textContent = r.text;
        this.bubble.appendChild(div);
      }
    }
    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
  }
}

// ---------- 余额（容器统一拉取/触发，与浏览器 PetMulti 同一套路径） ----------
function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 是否存在启用余额功能的宠物：全禁用时跳过余额轮询（不拉取，避免无意义的周期请求——与浏览器一致）
  const anyBalanceEnabled = sprites.some((s) => s.pet.balanceEnabled);

  // 余额周期轮询：eventsRefreshSec.balance（秒），成功递增 balanceTick 触发事件动画
  if (anyBalanceEnabled) {
    const intervalMs = Math.max(1000, (config.eventsRefreshSec?.balance ?? 1800) * 1000);
    const balanceLoop = async () => {
      try {
        const state = await S.fetchBalanceState(BALANCE_URL);
        balance = state;
        window.__dshPetDebug.lastBalanceOk = state && state.ok === true;
        if (state.ok) {
          balanceTick++;
          for (const s of sprites) s.onBalanceTick(state, balanceTick);
        } else if (state.reason !== 'unsupported') {
          console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
        }
      } catch (e) {
        console.error('[dsh-pet] 余额拉取异常', e);
      }
      setTimeout(() => void balanceLoop(), intervalMs);
    };
    void balanceLoop();
  }

  // 手动 /balance 触发：1s 轻量轮询触发计数（端点已禁止缓存），计数变化且余额启用时立即刷新余额并递增 tick
  let triggerBaseline = null;
  const triggerLoop = async () => {
    try {
      const count = await S.fetchTriggerCount(TRIGGER_URL);
      if (count < 0) return;
      if (triggerBaseline === null) {
        triggerBaseline = count; // 首次仅记基线：避免启动时重放历史触发
      } else if (count !== triggerBaseline) {
        triggerBaseline = count;
        if (anyBalanceEnabled) {
          const state = await S.fetchBalanceState(BALANCE_URL);
          balance = state;
          if (state.ok) {
            balanceTick++;
            for (const s of sprites) s.onBalanceTick(state, balanceTick);
          } else {
            console.error(
              '[dsh-pet] 手动触发余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''),
            );
          }
        }
      }
    } catch {
      /* 轻量轮询失败静默：下一周期再试 */
    }
    setTimeout(() => void triggerLoop(), 1000);
  };
  if (anyBalanceEnabled) void triggerLoop();
}

// ---------- 启动（配置校验通过才建 sprite；失败大声报错 + 5s 自动重试） ----------
async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    hideError();
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    if (pets.length === 0) {
      showError('配置中没有 display 为 desktop/both 的宠物，桌面模式不显示宠物');
      scheduleReboot();
      return;
    }
    for (const s of sprites) s.dispose();
    sprites = pets.map((p) => new PetSprite(p, cfg));
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const s of sprites) s.playIdle();
    updateClickThrough();
    startLoops();
  } catch (e) {
    showError('配置加载失败：' + (e && e.message ? String(e.message) : String(e)));
    scheduleReboot();
  }
}

// 注入打字资源：气泡字体 + 点击/拖拽光标图标（与浏览器 overlay 同一套素材，host 经 /dsh-pet-7340/ 提供）
function injectAssets() {
  const style = document.createElement('style');
  style.textContent =
    '@font-face{font-family:"ShangshouSoftCandy";src:url("' +
    ORIGIN +
    '/dsh-pet-7340/font/' +
    encodeURIComponent('上首软糖体') +
    '.ttf") format("truetype");font-display:swap;font-weight:400}' +
    '.pet-hit{cursor:url("' +
    ORIGIN +
    '/dsh-pet-7340/pic/cursor-grab.png") 16 16, grab}' +
    '.pet-hit.dragging{cursor:url("' +
    ORIGIN +
    '/dsh-pet-7340/pic/cursor-grabbing.png") 16 16, grabbing}';
  document.head.appendChild(style);
}

window.addEventListener('resize', () => {
  for (const s of sprites) s.position();
});

injectAssets();
void boot();
