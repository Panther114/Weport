import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import { join } from "path";
import { ConfigService } from "../services/config";

// 原生液态玻璃（Windows 专用）：DXGI 零拷贝采集 + D3D11 玻璃管线 + DComp 直接上屏，
// 感知滞后中位 ~6ms（Chromium 流方案 ~77ms），渲染完全不经过 Electron 进程。
// 默认关闭：原生面板在部分 GPU/驱动组合下会把折射区域画成黑块（弹窗背后出现
// 黑色矩形）。需要时用 WEPORT_NATIVE_GLASS=1 显式开启，回退路径为 Chromium 桌面流。
type NativeGlassModule = typeof import("@hicccc77/electron-liquid-glass");
let nativeGlass: NativeGlassModule | null = null;
try {
  const mod: NativeGlassModule = require("@hicccc77/electron-liquid-glass");
  nativeGlass = process.env.WEPORT_NATIVE_GLASS === "1" && mod.isSupported() ? mod : null;
} catch {
  nativeGlass = null;
}

// 用于处理通知点击的回调函数（导航到主窗口）
let onNotificationNavigate: ((payload: unknown) => void) | null = null;

export function setNotificationNavigateHandler(
  callback: (payload: unknown) => void,
) {
  onNotificationNavigate = callback;
}

let notificationWindow: BrowserWindow | null = null;
let closeTimer: NodeJS.Timeout | null = null;

// 空闲销毁：隐藏的通知窗口（含渲染进程）常驻占用 ~120MB 工作集，
// 通知稀少时不值得养着。隐藏后闲置超时即销毁，下一条通知重新冷启动
const IDLE_DESTROY_DELAY_MS = 3 * 60 * 1000;
let idleDestroyTimer: NodeJS.Timeout | null = null;

function cancelIdleDestroy() {
  if (idleDestroyTimer) {
    clearTimeout(idleDestroyTimer);
    idleDestroyTimer = null;
  }
}

function scheduleIdleDestroy() {
  cancelIdleDestroy();
  idleDestroyTimer = setTimeout(() => {
    idleDestroyTimer = null;
    // 可见期间不销毁（cancel/schedule 时序兜底）
    if (notificationWindow && !notificationWindow.isDestroyed() && notificationWindow.isVisible()) {
      scheduleIdleDestroy();
      return;
    }
    destroyNotificationWindow();
  }, IDLE_DESTROY_DELAY_MS);
  idleDestroyTimer.unref?.();
}

// 原生玻璃面板：与通知窗口一样常驻复用（创建后隐藏待命），
// 展示期跟随渲染层上报的卡片实测矩形（notification:glassRect）
let glassPanel: import("@hicccc77/electron-liquid-glass").GlassPanel | null = null;
// 面板创建时的 dpr：原生端几何常量按 dpr 换算且仅在创建时设定，
// 显示器缩放变化后必须重建面板，否则复用旧 dpr 会算错折射几何
let glassPanelDpr = 0;

function destroyGlassPanel() {
  if (glassPanel) {
    try {
      glassPanel.destroy();
    } catch {
      /* 面板已随会话销毁 */
    }
    glassPanel = null;
  }
}

// 视觉参数换算（缺省值与渲染层 GLASS_PARAMS 一致，CSS 值 → 物理像素/比例）
function toGlassParams(payload: Record<string, number | undefined>, scale: number) {
  return {
    cornerRadius: (payload.cornerRadius ?? 16) * scale,
    blurSigma: (payload.blurSigma ?? 2) * scale,
    displacementScale: payload.displacementScale ?? 70,
    aberrationIntensity: payload.aberrationIntensity ?? 1,
    saturation: (payload.saturation ?? 140) / 100,
  };
}

// 创建或复用玻璃面板并同步全部状态（不负责 show/hide）。
// 空闲预热与 glassRect 上报共用此路径：预热时占位几何 + 空亮度带，
// 首次上报会以实测值幂等覆盖
function ensureGlassPanel(
  bounds: { x: number; y: number; width: number; height: number },
  params: ReturnType<typeof toGlassParams>,
  scale: number,
  bands: Array<{ id: number; x: number; y: number; width: number; height: number }>,
) {
  if (!nativeGlass || !notificationWindow || notificationWindow.isDestroyed()) {
    return null;
  }
  if (glassPanel && glassPanelDpr !== scale) destroyGlassPanel();
  if (!glassPanel) {
    glassPanel = nativeGlass.createPanel({
      ...bounds,
      ...params,
      dpr: scale,
      anchorWindow: notificationWindow,
      lumaBands: bands,
      onLuma: (bandStats) => {
        if (notificationWindow && !notificationWindow.isDestroyed()) {
          notificationWindow.webContents.send("notification:luma", bandStats);
        }
      },
    });
    glassPanelDpr = scale;
  } else {
    glassPanel.setBounds(bounds);
    glassPanel.setParams(params);
    glassPanel.setLumaBands(bands);
    glassPanel.anchor(notificationWindow);
  }
  return glassPanel;
}

// —— 静态桌面快照（回退管线）——
// 弹窗展示时对屏幕拍一张静态快照（半分辨率），渲染层用 CSS 滤镜就地加工成玻璃，
// 替代 WeFlow 的 60fps 桌面视频流：零常驻开销、无 WebGL 帧循环，观感基本一致。
// 弹窗自身已设置 content protection，不会被拍进快照造成折射回环。
let cachedSnapshot: string | null = null;

async function captureDesktopSnapshot(): Promise<string | null> {
  try {
    const display = screen.getPrimaryDisplay();
    const scale = 0.5; // 半分辨率：玻璃模糊会抹平降采样，肉眼不可辨
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const source =
      sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    const thumb = source?.thumbnail;
    if (!thumb || thumb.isEmpty()) return null;
    cachedSnapshot = thumb.toDataURL();
    return cachedSnapshot;
  } catch (error) {
    console.warn("[NotificationWindow] Failed to capture desktop snapshot:", error);
    return null;
  }
}

export function destroyNotificationWindow() {
  cancelIdleDestroy();
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  lastNotificationData = null;
  destroyGlassPanel();

  if (!notificationWindow || notificationWindow.isDestroyed()) {
    notificationWindow = null;
    return;
  }

  const win = notificationWindow;
  notificationWindow = null;

  try {
    win.destroy();
  } catch (error) {
    console.warn("[NotificationWindow] Failed to destroy window:", error);
  }
}

// 窗口通过 min/max 锁定尺寸，程序化调整尺寸前需要同步放宽限制。
// 尺寸未变化时直接跳过：可见状态下重复 setSize 会让 DWM
// 短暂拉伸旧帧缓冲，在通知周围闪出一圈"幽灵轮廓"
function applyWindowSize(win: BrowserWindow, width: number, height: number) {
  const [currentWidth, currentHeight] = win.getSize();
  if (currentWidth === width && currentHeight === height) return;
  win.setMinimumSize(width, height);
  win.setMaximumSize(width, height);
  win.setSize(width, height);
}

export function createNotificationWindow() {
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    return notificationWindow;
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL;

  console.log("[NotificationWindow] Creating window...");
  const width = 344;
  const height = 114;

  // 透明窗口必须显式给透明背景色，否则 DWM 合成会以黑色兜底
  const iconPath = join(app.getAppPath(), "assets", "icons", "icon.png");
  notificationWindow = new BrowserWindow({
    width: width,
    height: height,
    type: "toolbar", // 辅助置顶（仅 Windows 走此窗口）
    frame: false,
    // 无边框透明窗口：不会出现 DWM 材质窗口的系统描边，
    // 玻璃底下的"桌面"由原生面板或渲染层的实时桌面视频流提供
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false, // 卡片投影由 CSS 提供
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false, // 不抢占焦点
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, "preload.js"), // FIX: Use correct relative path (same dir in dist)
      contextIsolation: true,
      nodeIntegration: false,
      // devTools: true // Enable DevTools
    },
  });

  // 用户要求通知窗口可被系统截图（与微信弹窗行为一致）。
  // 注意：setContentProtection(true) 会把窗口从屏幕采集排除（WDA_EXCLUDEFROMCAPTURE），
  // 导致系统截图/录屏中看不到弹窗——因此不再启用内容保护。
  // 玻璃回环风险由窗口尺寸小 + 渲染层重绘控制；如需恢复保护，直接启用下一行即可。
  // notificationWindow.setContentProtection(true);

  applyWindowSize(notificationWindow, width, height);

  // notificationWindow.webContents.openDevTools({ mode: 'detach' }) // DEBUG: Force Open DevTools
  notificationWindow.setIgnoreMouseEvents(true, { forward: true }); // 初始点击穿透

  // 处理鼠标事件 (如果需要从渲染进程转发，但目前特定区域处理?)
  // 实际上，我们希望窗口可点击。
  // 我们将在显示时将忽略鼠标事件设为 false。

  const loadUrl = isDev
    ? `${process.env.VITE_DEV_SERVER_URL}#/notification-window`
    : `file://${join(__dirname, "../dist/index.html")}#/notification-window`;

  console.log("[NotificationWindow] Loading URL:", loadUrl);
  notificationWindow.loadURL(loadUrl);

  // Chromium 会按 file:// 域持久化页面缩放（主窗口与通知窗口同域）：
  // 任何来源的缩放残留都会让通知按错误的逻辑尺寸排版，这里强制钉回 1
  notificationWindow.webContents.on("did-finish-load", () => {
    notificationWindow?.webContents.setZoomFactor(1);
  });

  notificationWindow.on("closed", () => {
    notificationWindow = null;
  });

  return notificationWindow;
}

export async function showNotification(data: any, opts?: { force?: boolean }) {
  // 先检查配置
  const config = ConfigService.getInstance();
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const channel = typeof data.channel === "string" ? data.channel : "";
  const isAiInsightNotification = channel === "ai-insight";

  if (!opts?.force) {
    if (isAiInsightNotification) {
      const enabled = await config.get("aiInsightNotificationEnabled");
      if (enabled === false) return; // 默认为 true
    } else {
      const enabled = await config.get("notificationEnabled");
      if (enabled === false) return; // 默认为 true

    // 检查会话过滤
    const filterMode = config.get("notificationFilterMode") || "all";
    const filterList = config.get("notificationFilterList") || [];
    // 系统通知（如 "Weport 准备就绪"）不是聊天消息，不应受会话白/黑名单影响
    const isSystemNotification = sessionId.startsWith("weport-");

    if (!isSystemNotification && filterMode !== "all") {
      const isInList = sessionId !== "" && filterList.includes(sessionId);
      if (filterMode === "whitelist" && !isInList) {
        // 白名单模式：不在列表中则不显示（空列表视为全部拦截）
        return;
      }
      if (filterMode === "blacklist" && isInList) {
        // 黑名单模式：在列表中则不显示
        return;
      }
    }
    }
  }

  cancelIdleDestroy();
  let win = notificationWindow;
  if (!win || win.isDestroyed()) {
    win = createNotificationWindow();
  }

  if (!win) return;

  // 确保加载完成
  if (win.webContents.isLoading()) {
    win.once("ready-to-show", () => {
      showAndSend(win!, data);
    });
  } else {
    showAndSend(win, data);
  }
}

let lastNotificationData: any = null;

async function showAndSend(win: BrowserWindow, data: any) {
  const config = ConfigService.getInstance();
  const position = (await config.get("notificationPosition")) || "top-right";

  // 更新位置：基于工作区完整矩形（含原点偏移）定位。
  // macOS 菜单栏、Windows 任务栏靠上/靠左时工作区原点不为 (0,0)，
  // 只用 workAreaSize 会把通知压进系统栏下面
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const winWidth = position === "top-center" ? 280 : 344;
  const winHeight = 114;
  const padding = 20;

  let x = 0;
  let y = 0;

  switch (position) {
    case "top-center":
      x = workArea.x + (workArea.width - winWidth) / 2;
      y = workArea.y + padding;
      break;
    case "top-right":
      x = workArea.x + workArea.width - winWidth - padding;
      y = workArea.y + padding;
      break;
    case "bottom-right":
      x = workArea.x + workArea.width - winWidth - padding;
      y = workArea.y + workArea.height - winHeight - padding;
      break;
    case "top-left":
      x = workArea.x + padding;
      y = workArea.y + padding;
      break;
    case "bottom-left":
      x = workArea.x + padding;
      y = workArea.y + workArea.height - winHeight - padding;
      break;
  }

  const winX = Math.floor(x);
  const winY = Math.floor(y);

  // 静态桌面快照（回退管线）：一条通知只拍一次，渲染层零常驻开销。
  // 原生玻璃可用时无需快照。
  const snapshot = !nativeGlass ? await captureDesktopSnapshot() : null;
  const payload = {
    ...data,
    position,
    backdrop: {
      native: Boolean(nativeGlass),
      sourceId: null,
      dataUrl: snapshot || undefined,
      winX,
      winY,
      width: display.size.width,
      height: display.size.height,
    },
  };
  lastNotificationData = payload;

  win.setPosition(winX, winY);
  // 窗口高度始终沿用渲染层的实测校准值（notification:resize），
  // 这里只同步宽度；反复重置高度会造成 114→实测高度的弹跳闪烁
  const [, currentHeight] = win.getSize();
  applyWindowSize(win, winWidth, currentHeight);

  win.webContents.send("notification:show", payload);

  // 设为可交互
  win.setIgnoreMouseEvents(false);
  win.showInactive(); // 显示但不聚焦
  win.setAlwaysOnTop(true, "screen-saver"); // 最高层级

  // 自动关闭计时器通常由渲染进程管理
  // 渲染进程发送 'notification:close' 来隐藏窗口
}

// 注册通知处理
export async function registerNotificationHandlers() {
  ipcMain.handle("notification:show", (_, data) => {
    showNotification(data);
  });

  ipcMain.handle("notification:close", () => {
    // 窗口即将隐藏，玻璃面板立即消失（渲染层通常已提前发过淡出信号）
    glassPanel?.hide(0);
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.hide();
      notificationWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    scheduleIdleDestroy();
  });

  // —— 原生玻璃面板生命周期（仅 nativeGlass 可用时渲染层才会发这些消息）——

  // 渲染层在卡片入场动画落定后上报实测几何（窗口本地 CSS 像素）
  ipcMain.on("notification:glassRect", (_event, payload) => {
    if (!nativeGlass || !notificationWindow || notificationWindow.isDestroyed()) return;
    const display = screen.getDisplayMatching(notificationWindow.getBounds());
    // 优先用渲染层实测的 devicePixelRatio（已含可能的页面缩放），显示器缩放兜底
    const scale = payload.dpr || display.scaleFactor;
    const [winX, winY] = notificationWindow.getPosition();
    const toPhysical = (rect: { x: number; y: number; width: number; height: number }) => ({
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    });
    const bounds = {
      x: Math.round((winX + payload.card.x) * scale),
      y: Math.round((winY + payload.card.y) * scale),
      width: Math.round(payload.card.width * scale),
      height: Math.round(payload.card.height * scale),
    };
    // 亮度带矩形是卡片本地坐标（带 id：0=整卡 1=标题行 2=正文）
    const bands = (payload.bands ?? []).map(
      (band: { id: number; x: number; y: number; width: number; height: number }) => ({
        id: band.id,
        ...toPhysical(band),
      }),
    );

    const panel = ensureGlassPanel(bounds, toGlassParams(payload, scale), scale, bands);
    panel?.show(120);
  });

  // 渲染层退场动画开始：面板与卡片的 0.3s 渐隐同步淡出
  ipcMain.on("notification:glassHide", () => {
    glassPanel?.hide(240);
  });

  // Handle renderer ready event (fix race condition)
  ipcMain.on("notification:ready", (event) => {
    console.log("[NotificationWindow] Renderer ready, checking cached data");
    if (
      lastNotificationData &&
      notificationWindow &&
      !notificationWindow.isDestroyed()
    ) {
      console.log("[NotificationWindow] Re-sending cached data");
      notificationWindow.webContents.send(
        "notification:show",
        lastNotificationData,
      );
    }
  });

  // 启动空闲期预热：
  // - 预创建通知窗口：首条通知免去窗口创建和渲染器冷启动
  // - 预创建原生玻璃面板（隐藏待命）：worker 线程、D3D 设备、着色器编译、
  //   DComp 窗口链全部离开首条通知的可见路径（原生端实测 ~150ms）；
  //   隐藏面板零渲染零采集，常驻开销可忽略
  // 仅当消息提醒开启时才预热（关闭时省掉常驻的弹窗渲染进程 ~60MB）
  const config = ConfigService.getInstance();
  const shouldPrewarm = (await config.get("messagePushEnabled")) === true || (await config.get("notificationEnabled")) !== false;
  if (!shouldPrewarm) return;
  setTimeout(() => {
    const win = createNotificationWindow();
    if (nativeGlass && win) {
      const scale = screen.getPrimaryDisplay().scaleFactor;
      const [winX, winY] = win.getPosition();
      ensureGlassPanel(
        {
          x: Math.round(winX * scale),
          y: Math.round(winY * scale),
          width: Math.round(344 * scale),
          height: Math.round(96 * scale),
        },
        toGlassParams({}, scale),
        scale,
        [],
      );
    }
    // 预热窗口若迟迟没有通知到来，按空闲策略回收
    scheduleIdleDestroy();
  }, 3000);

  // Handle resize request from renderer
  ipcMain.on("notification:resize", (event, { width, height }) => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      // Enforce max-height if needed, or trust renderer
      // Ensure it doesn't go off screen bottom?
      // Logic in showAndSend handles position, but we need to keep anchor point (top-right usually).
      // If we resize, we should re-calculate position to keep it anchored?
      // Actually, setSize changes size. If it's top-right, x/y stays same -> window grows down. That's fine for top-right.
      // If bottom-right, growing down pushes it off screen.

      // Simple version: just setSize. For V1 we assume Top-Right.
      // But wait, the config supports bottom-right.
      // We can re-call setPosition or just let it be.
      // If bottom-right, y needs to prevent overflow.

      // For now, let's just set the size as requested.
      applyWindowSize(notificationWindow, Math.round(width), Math.round(height));
    }
  });

  // 'notification-clicked' 在 main.ts 中处理 (导航)
}
