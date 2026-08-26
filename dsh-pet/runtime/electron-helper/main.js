/**
 * dsh-pet desktop helper —— Electron 主进程
 *
 * 职责：创建一个主屏工作区大小的全屏透明置顶窗口，加载 index.html
 * （共享逻辑 shared-core.js + 渲染端 renderer.js）。宠物 DOM 在画布内自由移动，
 * 窗口本身不移动；除宠物/气泡区域外点击穿透到下层应用。
 *
 * 与浏览器 overlay 严格对齐后，桌面模式不再轮询任何「状态」端点：
 *   - 配置 = /dsh-pet-7340/config.jsonc（经 renderer 拉取，含用户覆盖层合并）；
 *   - 动画素材 = /dsh-pet-7340/thumb/<name>.webm；
 *   - 余额 = /dsh-pet-7340/balance + /balance/trigger（与浏览器同一套轮询语义）；
 *   - 系统通知 = /dsh-pet-7340/notify 事件队列（1s 轮询，帧形状与浏览器 mux/host 流一致）。
 * renderer 需要的端点全部由 DSH_PET_CONFIG_URL 推导，主进程不再注入其它 URL。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;

function setClickThrough(ignore) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(ignore === true, { forward: true });
  }
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea; // 主屏工作区（不含任务栏）
  const width = area.width;
  const height = area.height;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: area.x,
    y: area.y,
    show: false,
    useContentSize: true,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      paintWhenInitiallyHidden: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setClickThrough(true);

  mainWindow
    .loadFile('index.html', {
      query: {
        configUrl: process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config.jsonc',
        scale: process.env.DSH_PET_SCALE || '1',
      },
    })
    .catch((error) => {
      console.error('[dsh-pet-desktop-helper] page load failed:', error);
      app.quit();
    });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  ipcMain.on('pet:set-ignore-mouse', (_event, { ignore }) => {
    setClickThrough(ignore === true);
  });

  // 冒烟自检模式（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证透明窗口/渲染/动画链路（如 CI 或本地验证）。
  if (process.env.DSH_PET_SMOKE === '1') {
    const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
    const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
    // 转发渲染端 console（定位动画/余额/错误问题）
    mainWindow.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message}`);
    });
    setTimeout(async () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const dump = await mainWindow.webContents.executeJavaScript(`({
            hasBridge: typeof window.petBridge !== 'undefined',
            viewport: window.innerWidth + 'x' + window.innerHeight,
            dpr: window.devicePixelRatio,
            debug: window.__dshPetDebug || null,
            sprites: document.querySelectorAll('.pet-sprite').length,
            errorVisible: document.getElementById('pet-error').classList.contains('visible'),
            errorText: document.getElementById('pet-error').textContent,
            firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
            firstRoot: (function () {
              var el = document.querySelector('.pet-sprite');
              return el ? el.style.left + ',' + el.style.top : '';
            })(),
            videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
            videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
            hitCursor: (function () {
              var hit = document.querySelector('.pet-hit');
              return hit ? getComputedStyle(hit).cursor : '';
            })(),
            dragTransform: (function () {
              // 回归断言：纯点击不得把舞台拍平（人物瞬移）；拖拽超过阈值才拍平，松开恢复
              var hit = document.querySelector('.pet-hit');
              var stage = document.querySelector('.pet-stage');
              if (!hit || !stage) return 'no-sprite';
              var out = { idle: stage.style.transform };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, pointerId: 91 }));
              out.duringClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, pointerId: 91 }));
              out.afterClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, pointerId: 92 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, pointerId: 92 }));
              out.duringDrag = stage.style.transform;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, pointerId: 92 }));
              out.afterDrag = stage.style.transform;
              return out;
            })()
          })`);
          console.log('[dsh-pet-desktop-helper] smoke dump:', JSON.stringify(dump));
          const image = await mainWindow.webContents.capturePage();
          writeFileSync(smokeOut, image.toPNG());
          console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
        }
      } catch (error) {
        console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
      }
      setTimeout(() => app.quit(), 500);
    }, afterMs);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
