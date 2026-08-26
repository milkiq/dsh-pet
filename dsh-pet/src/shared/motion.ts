// 移动几何与角落定位：纯计算（无 DOM / ref），可独立单测。
// 坐标语义：移动规划归一化为视口比例（ratio），px 换算由调用方（rAF 驱动 / customPos）完成；
// 角落定位返回宠物根节点左上角的像素坐标（浏览器 overlay 用 CSS 同语义，桌面模式用它摆放 sprite）。
import { randomBetween } from './pickers';
import type { Corner } from './types';

/** 一次移动的几何参数（比例坐标） */
export interface MovePlan {
  startRatio: number;
  startYRatio: number;
  targetRatio: number;
  totalRatio: number;
}

/** 计算一次移动的起点/终点比例坐标；目标越出视口边缘（含边距）时返回 null */
export const planMove = (o: {
  cx: number;
  cy: number;
  W: number;
  H: number;
  dir: 1 | -1;
  minDist: number;
  maxDist: number;
  margin: number;
  halfW: number;
}): MovePlan | null => {
  const distance = randomBetween(o.minDist, o.maxDist);
  const target = o.cx + o.dir * distance;
  const leftBound = o.margin + o.halfW;
  const rightBound = o.W - o.margin - o.halfW;
  if (target < leftBound || target > rightBound) return null;
  return {
    startRatio: o.cx / o.W,
    startYRatio: o.cy / o.H,
    targetRatio: target / o.W,
    totalRatio: Math.abs(target - o.cx) / o.W,
  };
};

/**
 * 角落 + 边距 → 宠物根节点左上角像素坐标。
 * 与浏览器 overlay 的 CSS 角落语义一致：
 *   top-left     = left:marginX, top:marginY
 *   top-right    = right:marginX, top:marginY
 *   bottom-left  = left:marginX, bottom:marginY
 *   bottom-right = right:marginX, bottom:marginY
 * 桌面模式的视口即全屏透明画布，用同一套几何摆放 sprite。
 */
export const anchorPixel = (o: {
  corner: Corner;
  marginX: number;
  marginY: number;
  size: number;
  W: number;
  H: number;
}): { x: number; y: number } => {
  const height = (o.size * 9) / 16;
  switch (o.corner) {
    case 'top-left':
      return { x: o.marginX, y: o.marginY };
    case 'top-right':
      return { x: o.W - o.size - o.marginX, y: o.marginY };
    case 'bottom-left':
      return { x: o.marginX, y: o.H - height - o.marginY };
    case 'bottom-right':
      return { x: o.W - o.size - o.marginX, y: o.H - height - o.marginY };
  }
};
