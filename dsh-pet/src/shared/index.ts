// src/shared —— 浏览器 bundle 与桌面 shared-core（构建产物）共用的纯逻辑层。
// 约定：
//   - 只含无 React / DOM 依赖的纯函数、类型、常量、配置校验；
//   - host 半侧**不得** import 本目录（DSH 单文件加载约束会拆 chunk 导致加载失败），
//     宿主只保留 stripJsonc 与 display 白名单两个被注释说明的极小拷贝；
//   - 新增「行为」请落在这里 + 两边的薄壳（浏览器 React 组件 / 桌面 DOM sprite）。
export * from './types';
export * from './constants';
export * from './pickers';
export * from './motion';
export * from './balance';
export * from './whisper';
export * from './config';
export * from './notify';
export * from './menu'; // 统一右键菜单（本目录唯一的 DOM 例外：树=纯函数，渲染=两端共用同一份）
export * from './physics'; // 拖拽抛掷物理（弹簧跟手 + 甩抛 + 重力反弹）
