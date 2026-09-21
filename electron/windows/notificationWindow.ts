import { app, BrowserWindow, desktopCapturer, ipcMain, screen, shell } from "electron";
import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import { ConfigService } from "../services/config";
import {
  hasNotificationDaemon,
  invalidateNotificationDaemonCache,
  resolveLinuxNotificationMode,
  sendLinuxNotification,
} from "../services/linuxNotify";
import { openWeChat } from "../services/wechatLinux";

// 原生液态玻璃（Windows 专用）：DXGI 零拷贝采集 + D3D11 玻璃管线 + DComp 直接上屏，
// 感知滞后中位 ~6ms（Chromium 流方案 ~77ms），渲染完全不经过 Electron 进程。
//
// **默认关闭，`WEPORT_NATIVE_GLASS=1` 才启用。**
//
// 为什么又关回去了（这次有现场证据）：v1.0.0-preview 的安装版把默认值改成了开，
// 随后用户报「弹窗通知的背景全黑」。这正是本文件很久以前就记下的那个失败模式 ——
// 「早期版本在部分 GPU/驱动组合下把折射区画成黑块」：面板是一个独立原生窗口，当它
// 拿不到/画不出桌面纹理时，屏幕上出现的就是**一块黑色矩形**，而它在渲染层的
// `data-glass` 仍然写着 `native`（所以探针会以为一切正常）。
//
// 对比度与透明度的账也要算清：`isSupported()` 只能判断"这套组合是否被支持"，判断不了
// "此刻是否真的画出了桌面"。既然如此，就不该让默认值赌在这上面 —— 玻璃的意义就是
// **看得见桌面**，画不出桌面时它是负资产。
//
// 回退（Chromium 定帧）在本机虽然只有 ~1.5Hz，但它是**把桌面快照合成进卡片内部**：
// 最差情况是没有快照、只剩一层近乎全透明的纱层 —— 仍然是"透明玻璃"，永远不会变成
// 一块黑板。这才是可接受的默认行为。
//
// 需要 60fps 折射的机器可以显式打开：`WEPORT_NATIVE_GLASS=1`。
// 仅 win32 加载：模块本身是 Windows 原生实现（DXGI/D3D11），macOS/Linux 一律走回退。
type NativeGlassModule = typeof import("@hicccc77/electron-liquid-glass");
let nativeGlass: NativeGlassModule | null = null;
try {
  const mod: NativeGlassModule = require("@hicccc77/electron-liquid-glass");
  const explicitlyEnabled = process.env.WEPORT_NATIVE_GLASS === "1";
  nativeGlass =
    process.platform === "win32" && explicitlyEnabled && mod.isSupported() ? mod : null;
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

const DEFAULT_NOTIFICATION_DURATION_MS = 3000;
const MIN_NOTIFICATION_DURATION_MS = 1000;
const MAX_NOTIFICATION_DURATION_MS = 60_000;

/**
 * 卡片宽度的缺省与边界（与渲染层 `src/utils/notificationGlass.ts` 的常量保持一致）。
 *
 * v1.0.1 起宽度是**用户可配置**的（设置 → 消息通知设置 → 通知玻璃 → 基础宽度），
 * 而且卡片会按昵称长度自适应再加宽（渲染层算出最终宽度后通过 notification:resize
 * 回报）。主进程只在"弹出前"需要一个初值来定位窗口 —— 它不该猜，读配置；
 * 读不到就退回 344（v1.0.0 之前的固定宽度）。
 */
const DEFAULT_CARD_WIDTH = 344;
const MIN_CARD_WIDTH = 300;
const MAX_CARD_WIDTH = 640;

function normalizeCardWidth(value: unknown): number {
  const width = Number(value);
  if (!Number.isFinite(width)) return DEFAULT_CARD_WIDTH;
  return Math.round(Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, width)));
}

/** 卡片四周的基础留白（与渲染层 notificationGlass.ts 的常量保持一致）。 */
const CARD_BASE_PADDING = 8;

/**
 * 投影占用的额外留白 —— **必须与渲染层 `notificationShadowMargin` 逐值一致**。
 *
 * 窗口尺寸 = 卡片宽度 + 2×留白，所以弹出前定位用的宽度必须把留白算进去，
 * 否则"投影"拉大之后首次定位会偏，要等渲染层报回尺寸才纠正（看得见的跳动）。
 * 参数与 `notificationShadowLayers` 是同一组数：偏移 3..9、模糊 8..20，
 * 留白 min(36, ceil(偏移 + 模糊) + 2)。
 */
function shadowMargin(shadow: unknown): number {
  const t = Math.min(100, Math.max(0, Number(shadow) || 0)) / 100;
  if (t <= 0) return 0;
  const offsetY = Math.round(3 + t * 6);
  const blur = Math.round(8 + t * 12);
  return Math.min(36, Math.ceil(offsetY + blur) + 2);
}

/** 窗口的完整宽度（卡片 + 两侧留白） */
function notificationWindowWidth(config: ConfigService): number {
  const card = normalizeCardWidth(notifGlassGet(config, "notificationGlassWidth"));
  const pad = CARD_BASE_PADDING + shadowMargin(notifGlassGet(config, "notificationGlassShadow"));
  return card + pad * 2;
}

/**
 * 读通知玻璃配置。
 *
 * `notificationGlass*` 不在 `ConfigSchema` 里（渲染层通过非类型化的 config IPC
 * 读写，与外观/主题那些键同一套做法），所以这里走 `(config as any).get` —— 与
 * appMain.ts 的 `config:get` 处理器保持一致，不为了一个键去改全局 schema。
 */
function notifGlassGet(config: ConfigService, key: string): unknown {
  try {
    return (config as unknown as { get: (k: string) => unknown }).get(key);
  } catch {
    return undefined;
  }
}

function normalizeNotificationDuration(value: unknown): number {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return DEFAULT_NOTIFICATION_DURATION_MS;
  return Math.min(MAX_NOTIFICATION_DURATION_MS, Math.max(MIN_NOTIFICATION_DURATION_MS, Math.round(duration)));
}

// 空闲回收：通知窗口（一整个渲染进程 + 合成层，实测 ~106-130MB）在最后一条通知
// 之后闲置这么久就销毁，下一条通知再按需创建。3 分钟太长 —— 用户"看一眼
// 任务管理器"的时间窗正好落在里面，而冷启动一条通知只要几百毫秒。
//
// v1.0.4：3 分钟 → 45s。理由是实测：本机（16GB / Intel Iris Xe 核显）弹窗渲染进程
// 存活时整机占用 912MB = 5.66%，销毁后回到 ~462MB = 2.87% —— **这 130MB 就是
// 用户"空闲却看到 5.7%"的主要来源之一**。45s 仍然覆盖得住"连续几条消息"的节奏
// （每次 show 都会 cancelIdleDestroy 重新计时，所以一串通知只销毁一次），
// 同时把"最后一条之后还白养着一个渲染进程"的时间砍掉 75%。
const IDLE_DESTROY_DELAY_MS = 45 * 1000;

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

// —— 实时桌面折射 ——
//
// 玻璃背景必须在弹窗的**整个生命周期**里跟着桌面走：静态快照会让背景定格在弹出
// 那一刻，看起来像贴了一张旧截图（用户报的就是这个）。
//
// 两条路，按可用性选：
//   1. 渲染层 getUserMedia + 采集源 ID —— Windows 上走 WGC，30fps、GPU 合成、
//      主进程零成本。部分环境（虚拟机/无 GPU/驱动不支持）WGC 会以
//      E_ACCESSDENIED 失败，此时自动落到第 2 条。
//   2. 主进程定帧抓取（desktopCapturer.getSources，GDI 兜底）—— 单帧在本机实测
//      ~105ms（无 DXGI 加速），因此按实测成本自适应间隔，默认 ~3fps。玻璃本身是
//      模糊的，低帧率不容易被察觉，但"完全不动"一眼就能看出来。
//
// 两条路都只在弹窗可见期间运行；隐藏/销毁立刻停（见 stopBackdropStream）。
//
// 自拍回环：实时画面会拍到弹窗自己。唯一可靠的排除手段是
// WDA_EXCLUDEFROMCAPTURE（setContentProtection(true)），而它是**捕获期**属性：
// 弹窗可见期间开着它，系统截图/录屏就拍不到弹窗本体（用户已确认接受的取舍）。
// 隐藏时立刻关掉。

let cachedSourceId: string | null = null;
let sourceIdInflight: Promise<string | null> | null = null;

async function refreshDesktopSourceId(): Promise<string | null> {
  // Linux 一律不解析采集源：Wayland 下任何 desktopCapturer 调用都会拉起
  // xdg-desktop-portal 的屏幕共享授权。放在这里守卫，未来新增调用点也不会漏。
  if (process.platform === "linux") return null;
  if (sourceIdInflight) return sourceIdInflight;
  sourceIdInflight = (async () => {
    try {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      cachedSourceId = source?.id ?? null;
      return cachedSourceId;
    } catch (error) {
      console.warn("[NotificationWindow] Failed to resolve desktop source id:", error);
      return null;
    } finally {
      sourceIdInflight = null;
    }
  })();
  return sourceIdInflight;
}

/** 启动时预热采集源，让首条通知不必等采集管线初始化 */
export function prewarmDesktopSourceId(): void {
  // Linux 默认走系统通知，应用内弹窗只是无采集的兜底，没有可预热的东西
  if (process.platform === "linux") return;
  if (nativeGlass) return;
  void refreshDesktopSourceId();
}

// 定帧抓取循环的状态
let backdropTimer: NodeJS.Timeout | null = null;
let backdropRunning = false
/** 已推给渲染层的帧数（含重复帧；用于 QA 断言） */
let backdropLastSeq = 0;
let backdropFramesSent = 0;
/** 最近一次单帧实测耗时，用于自适应间隔（慢机器上主动降帧） */
let lastFrameCostMs = 0;
/** 渲染层报上来的折射模式：stream = WGC 视频流已接管，主进程不需要再抓帧 */
let backdropMode: "frames" | "stream" | "native" = "frames";

function stopBackdropStream() {
  backdropRunning = false;
  backdropFramesSent = 0;
  backdropLastSeq = 0;
  if (backdropTimer) {
    clearTimeout(backdropTimer);
    backdropTimer = null;
  }
  setLiveGlassProtection(false);
}

/**
 * 抓一帧桌面（低分辨率 JPEG）。
 *
 * JPEG 而不是 PNG：玻璃会再模糊一次，压缩噪点看不见；而编码成本差 5 倍以上
 * （本机实测 PNG 7.6ms / JPEG 1.6ms，体积 56KB / 32KB），在几百毫秒一帧的循环里
 * 这个差别直接决定能不能跑。
 *
 * 抓帧分辨率比例（相对显示器尺寸）从 0.5 降到 0.25 是本轮延迟优化的关键：
 * `desktopCapturer.getSources` 的成本几乎完全由输出像素数决定，4K 屏上 0.5
 * 意味着每秒要生成好几张 1920×1080 位图，主进程直接饱和 —— 而这张图**接下来
 * 会被玻璃整张模糊掉**，分辨率本身毫无价值。0.25（4K 屏约 960×540）在玻璃里
 * 看不出区别，成本降到约 1/4。竖直方向尤其浪费：弹窗只有 ~114px 高，采样时
 * 还要缩到 48×16，真正被消费的信息量只有几百个像素。
 */
const BACKDROP_CAPTURE_SCALE = 0.25
/** JPEG 质量：玻璃会再模糊一次，压缩噪点看不见，但编码成本差很多 */
const BACKDROP_JPEG_QUALITY = 55

async function grabDesktopFrame(): Promise<string | null> {
  const startedAt = Date.now();
  try {
    const display = screen.getPrimaryDisplay();
    const scale = BACKDROP_CAPTURE_SCALE;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!cachedSourceId && source?.id) cachedSourceId = source.id;
    const thumb = source?.thumbnail;
    if (!thumb || thumb.isEmpty()) return null;
    const dataUrl = `data:image/jpeg;base64,${thumb.toJPEG(BACKDROP_JPEG_QUALITY).toString("base64")}`;
    return dataUrl;
  } catch (error) {
    console.warn("[NotificationWindow] desktop frame grab failed:", error);
    return null;
  } finally {
    lastFrameCostMs = Date.now() - startedAt;
  }
}

/**
 * 定帧折射循环：抓一帧 → 推给弹窗 → 按实测帧成本决定下一帧的间隔。
 *
 * 间隔取 3 倍帧成本（给主进程留出处理其它 IPC 的余量），下限 200ms（约 5fps），
 * 上限 1000ms —— 再慢就成了"几乎不动"，与静态快照无异。
 *
 * 循环**不能**因为"此刻不可见"就退出：showInactive() 之后 Windows 要过一小会儿
 * 才把窗口标成可见，第一轮就判定不可见会让整个循环直接不跑（第一版就栽在这里，
 * 表现为弹窗玻璃始终是 snapshot）。可见性只用来决定"这一轮要不要抓帧"，真正
 * 的退出条件是 stopBackdropStream()。
 */
async function runBackdropStream() {
  // Linux 不跑抓帧循环：这是 portal「共享屏幕」弹窗的来源。应用内弹窗在这条路上
  // 只保留用户配置的整卡填充，没有实时桌面折射。
  if (process.platform === "linux") return;
  if (backdropRunning || nativeGlass) return;
  if (!notificationWindow || notificationWindow.isDestroyed()) return;
  backdropRunning = true;
  setLiveGlassProtection(true);
  let invisibleStreak = 0;
  let frameIndex = 0;
  while (backdropRunning && notificationWindow && !notificationWindow.isDestroyed()) {
    if (backdropMode === "stream") {
      console.log(`[NotificationWindow] backdrop loop handed over to the WGC stream after ${frameIndex} frame(s)`);
      break;
    }
    const visible = notificationWindow.isVisible();
    if (!visible) {
      // 可见性只决定这一轮抓不抓帧，**不能**当退出条件：Windows 上 isVisible()
      // 会在某些时刻（刚显示、被遮挡判定、DWM 状态切换）返回 false，而弹窗其实
      // 就在屏幕上。第一版按"连续 20 轮不可见就退出"写，结果是玻璃抓了几帧之后
      // 停住 —— 正是用户报的"背景被钉在出现那一刻"。真正的退出条件是
      // stopBackdropStream()（notification:close / 窗口销毁）。
      invisibleStreak += 1;
      if (invisibleStreak % 20 === 0) {
        console.log(`[NotificationWindow] backdrop loop: window reported invisible ${invisibleStreak}x (still running)`)
      }
    } else {
      invisibleStreak = 0;
      const dataUrl = await grabDesktopFrame();
      if (!backdropRunning) break;
      if (dataUrl && notificationWindow && !notificationWindow.isDestroyed()) {
        const [winX, winY] = notificationWindow.getPosition();
        const display = screen.getPrimaryDisplay();
        backdropLastSeq += 1;
        notificationWindow.webContents.send("notification:backdrop", {
          seq: backdropLastSeq,
          dataUrl,
          winX,
          winY,
          width: display.size.width,
          height: display.size.height,
        });
        frameIndex += 1;
        backdropFramesSent += 1;
        if (process.env.WEPORT_DUMP_BACKDROP === `1` && frameIndex <= 3) {
          try {
            writeFileSync(join(app.getPath(`temp`), `weport-backdrop-` + frameIndex + `.jpg`), Buffer.from(dataUrl.split(`,`)[1], `base64`));
          } catch { /* noop */ }
        }
        if (frameIndex === 1 || frameIndex % 10 === 0) {
          console.log(`[NotificationWindow] backdrop frame #${frameIndex} (${lastFrameCostMs}ms)`);
        }
      }
    }
    const interval = Math.max(200, Math.min(1000, Math.round(lastFrameCostMs * 3) || 300));
    await new Promise<void>((resolve) => {
      backdropTimer = setTimeout(resolve, interval);
      backdropTimer.unref?.();
    });
  }
  backdropTimer = null;
}

// 实时玻璃期间是否由我们开着内容保护（隐藏时要还原成关）
let liveGlassProtection = false;
/**
 * 截图 QA 专用开关：`webContents.capturePage` 在开着内容保护的窗口上只能拿到
 * 空白帧（见 AGENTS 的 QA 说明），QA 因此需要自己接管这块状态。置为 true 后
 * setLiveGlassProtection 不再改动窗口的 contentProtection，由 QA 决定。
 */
let liveGlassProtectionSuppressed = false;

export function suppressLiveGlassProtection(suppress: boolean): void {
  liveGlassProtectionSuppressed = suppress;
}

/** 已经推给弹窗的桌面帧数（截图 QA 用它作为"折射循环真的在跑"的证据） */
export function getBackdropFrameCount(): number {
  return backdropFramesSent;
}

/** 最新帧序号：渲染层写进 data-glass-seq，QA 用它证明玻璃显示的是最新帧而不是首帧 */
export function getBackdropSeq(): number {
  return backdropLastSeq;
}

function setLiveGlassProtection(on: boolean) {
  if (nativeGlass || liveGlassProtectionSuppressed) return;
  if (!notificationWindow || notificationWindow.isDestroyed()) return;
  if (liveGlassProtection === on) return;
  try {
    notificationWindow.setContentProtection(on);
    liveGlassProtection = on;
  } catch { /* noop */ }
}


export function destroyNotificationWindow() {
  cancelIdleDestroy();
  stopBackdropStream();
  liveGlassProtection = false;
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
      // 关闭拼写检查（弹窗无文本输入，省词典内存）
      spellcheck: false,
      // devTools: true // Enable DevTools
    },
  });

  // 内容保护（WDA_EXCLUDEFROMCAPTURE）与"玻璃能不能实时"是同一个取舍的两端：
  //   - 关着它：系统截图/录屏能看到弹窗，但桌面视频流会把弹窗自己拍进去，
  //     玻璃里出现"弹窗套弹窗"，因此玻璃只能是一张静态快照（旧行为）；
  //   - 开着它：玻璃可以逐帧跟随桌面（现在的行为），代价是弹窗可见的那几秒
  //     不会被系统截图/录屏拍到。
  //
  // 2026-09-13 由用户确认选择后者（实时玻璃优先）。这里不在创建时开启，而是由
  // setLiveGlassProtection 在**通知可见期间**开启、隐藏时立即关闭：弹窗不在画面上
  // 时没有任何理由继续把窗口排除在截图之外。
  // 想把弹窗拍进截图的话，改回静态快照（renderer 不传 backdropStream）并去掉
  // setLiveGlassProtection(true)。

  applyWindowSize(notificationWindow, width, height);

  // notificationWindow.webContents.openDevTools({ mode: 'detach' }) // DEBUG: Force Open DevTools
  notificationWindow.setIgnoreMouseEvents(true, { forward: true }); // 初始点击穿透

  // 处理鼠标事件 (如果需要从渲染进程转发，但目前特定区域处理?)
  // 实际上，我们希望窗口可点击。
  // 我们将在显示时将忽略鼠标事件设为 false。

  // v0.9.3 起使用独立瘦身入口 popup.html（不加载 App/ECharts 主包），
  // 渲染进程内存更低、首条通知出现更快
  const loadUrl = isDev
    ? `${process.env.VITE_DEV_SERVER_URL}/popup.html`
    : `file://${join(__dirname, "../dist/popup.html")}`;

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

  notificationWindow.webContents.on("will-navigate", (event, url) => {
    const devServer = process.env.VITE_DEV_SERVER_URL || "";
    const allowed = devServer ? url.startsWith(devServer) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });
  notificationWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  return notificationWindow;
}

/**
 * 系统通知的图标。
 *
 * 打包后 `assets/icons/icon.png` 在 app.asar 里，**外部进程**（notify-send）读不到，
 * 只能退回主题图标名；开发态直接用真实文件，图标能显示出来。
 */
function resolveSystemNotificationIcon(): string {
  try {
    const candidate = join(app.getAppPath(), "assets", "icons", "icon.png");
    if (!candidate.includes(".asar") && existsSync(candidate)) return candidate;
  } catch { /* app 尚未就绪时用图标名兜底 */ }
  return "weport";
}

/**
 * Linux：把通知投给桌面通知守护进程（mako/dunst/swaync…）。
 *
 * 返回 true 表示已经处理掉，调用方不要再创建应用内弹窗。
 * 守护进程不可用或发送失败时返回 false —— 回退路径（应用内弹窗）同样不抓桌面。
 */
async function trySendSystemNotification(data: any): Promise<boolean> {
  const config = ConfigService.getInstance();
  const mode = resolveLinuxNotificationMode(
    process.env.WEPORT_LINUX_NOTIFY,
    await config.get("linuxNotificationMode"),
  );
  if (mode === "off") return false;

  if (mode === "auto" && !(await hasNotificationDaemon())) {
    console.log("[NotificationWindow] Linux 未检测到通知守护进程，回退应用内弹窗");
    return false;
  }

  const isChatMessage = data?.channel === "message";
  const ok = await sendLinuxNotification({
    title: String(data?.title || data?.senderName || "微信消息"),
    body: String(data?.content ?? data?.body ?? ""),
    icon: resolveSystemNotificationIcon(),
    timeoutMs: normalizeNotificationDuration(await config.get("notificationDuration")),
    // 聊天消息用标准分类，mako/dunst 可以按它路由或过滤
    category: isChatMessage ? "im.received" : undefined,
    // 点击通知 → 打开微信（没运行就启动，在运行就聚焦窗口）。WeBot/AI 通知
    // 没有"回微信"的语义，不挂动作。
    actionLabel: isChatMessage ? "打开微信" : undefined,
    onAction: isChatMessage ? () => { void openWeChat(); } : undefined,
  });

  if (!ok) {
    // 发送失败（守护进程刚退出 / 未安装 notify-send）：清掉检测缓存让下一条
    // 通知重新探测，然后回退到应用内弹窗 —— 消息不能因为系统通知故障而消失。
    invalidateNotificationDaemonCache();
    return false;
  }
  return true;
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

  // Linux：优先把通知交给系统通知守护进程（mako/dunst/swaync…）。
  //
  // 为什么：应用内弹窗的实时玻璃要 desktopCapturer 抓整个桌面，Wayland 下这会
  // 触发 xdg-desktop-portal 的「共享屏幕」授权框；而且弹窗的位置/超时/外观无法
  // 复用用户对通知守护进程的配置，在 Linux 上等于重复造轮子。检测不到守护进程时
  // 回退应用内弹窗 —— 回退路径已彻底关闭桌面采集（见 showAndSend 的 backdrop 与
  // runBackdropStream 的平台守卫），所以任何情况下都不会再触发 portal。
  //
  // 截图 QA 模式是唯一例外：它必须捕获应用自己的弹窗，见 appMain 里对
  // WEPORT_SCREENSHOT_POPUP 的设置。
  if (process.platform === "linux" && process.env.WEPORT_SCREENSHOT_POPUP !== "1") {
    if (await trySendSystemNotification(data)) return;
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
  const notificationDuration = normalizeNotificationDuration(await config.get("notificationDuration"));
  const notificationAnimationEnabled = (await config.get("notificationAnimationEnabled")) !== false;

  // 更新位置：基于工作区完整矩形（含原点偏移）定位。
  // macOS 菜单栏、Windows 任务栏靠上/靠左时工作区原点不为 (0,0)，
  // 只用 workAreaSize 会把通知压进系统栏下面
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  // 弹出前用**用户配置的基础宽度**定位；卡片实测宽度（可能因长昵称更大）会在
  // 渲染层上报后由 notification:resize 重算坐标，见下面的 resize 处理。
  // top-center 过去写死 280：那是"卡片比别的角窄"的历史遗留，现在统一走配置。
  const winWidth = notificationWindowWidth(config);
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
  // 窗口的**当前实际**尺寸（DIP）：主题采样要靠它把取样点挪出窗口，见下面的 winW/winH
  const [currentWinW, currentWinH] = win.getSize();

  // 弹窗弹出路径上**不做任何采集**：一次桌面抓取在本机实测 ~105ms，放在这里
  // 就是每条通知都晚出现一小截。首帧交给下面的折射循环，弹窗先出现。
  const backdropGeometry = {
    winX,
    winY,
    width: display.size.width,
    height: display.size.height,
    /**
     * 窗口自身的尺寸（DIP）。
     *
     * 渲染层解主题时要按它把取样点挪到窗口**外面**：抓帧抓的是整屏，窗口自己就在
     * 屏幕上，直接采样卡片那一片等于拿弹窗自己的像素去决定弹窗的主题 —— 自指闭环，
     * 第一次采到亮色就永远选深色文字（实测换背景、甚至关掉重弹都不会变）。
     */
    winW: currentWinW,
    winH: currentWinH,
  };
  const payload = {
    ...data,
    position,
    notificationDuration,
    notificationAnimationEnabled,
    backdrop: process.platform === "linux"
      ? {
          // Linux 不提供采集源：sourceId 为 null 时渲染层不会发起 getUserMedia
          // （见 NotificationWindow.tsx），主进程的定帧循环也不会启动。玻璃只保留
          // 用户配置的整卡填充，观感由主题引擎在"无快照"下照常解出。
          native: false,
          sourceId: null,
          ...backdropGeometry,
        }
      : {
          native: Boolean(nativeGlass),
          // 渲染层优先用它开 WGC 视频流（30fps、GPU 合成、主进程零成本）；不可用时
          // 自动落到主进程的定帧循环（runBackdropStream）
          sourceId: nativeGlass ? null : cachedSourceId,
          ...backdropGeometry,
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

  // 显示之后才开始抓帧：此时内容保护已经能生效（排除弹窗自身），
  // 而且首帧正好赶在入场动画期间到达
  backdropMode = nativeGlass ? "native" : "frames";
  void runBackdropStream();

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
    stopBackdropStream();
    // 实时玻璃的内容保护随可见期结束一起撤掉：弹窗不在画面上时没有任何理由
    // 继续把窗口排除在截图之外。
    setLiveGlassProtection(false);
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.hide();
      notificationWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    scheduleIdleDestroy();
  });

  // 渲染层接管折射（WGC 视频流已出帧）：主进程停掉定帧抓取，避免白花 CPU。
  // 反向切回（流中断）不需要处理：流一旦建立就由渲染层持有到弹窗隐藏。
  ipcMain.on("notification:glassMode", (_event, payload: { mode?: string }) => {
    if (payload?.mode === "stream") backdropMode = "stream";
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

  // 启动空闲期预热（v1.0.3 收窄）：**不再预创建通知窗口**。
  //
  // 旧行为：启动 3s 后无条件 createNotificationWindow()，常驻一整个渲染进程
  // 等第一条通知。实测那是一个 **106MB 工作集**（344×115 的窗口，popup.html
  // 完整渲染进程 + 合成层）——在"开机自启 + 托盘常驻"这个最常见的形态下，
  // 用户打开任务管理器时看到的就是它，而它 99% 的时间什么都不做。
  //
  // 冷启动这条路本来就是通的、而且是被产品验证过的：showNotification 内部
  // 会按需 createNotificationWindow()，下面这条注释原本就写着"按需冷启动，
  // 功能不受影响"。所以这里只保留**零渲染开销**的预热（桌面采集源 id，
  // 不创建窗口、不创建渲染进程），窗口本身交给第一条真实通知。
  //
  // 恢复"预创建"只需要把 createNotificationWindow() 加回来 —— 代价是那 106MB。
  const config = ConfigService.getInstance();
  const shouldPrewarm = (await config.get("messagePushEnabled")) === true;
  if (!shouldPrewarm) return;
  setTimeout(() => {
    prewarmDesktopSourceId();
  }, 3000);

  // Handle resize request from renderer
  ipcMain.on("notification:resize", (event, { width, height }) => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      const win = notificationWindow;
      const prevSize = win.getSize();
      applyWindowSize(win, Math.round(width), Math.round(height));

      /**
       * 尺寸变化后必须**重新贴边**（v1.0.1 起宽度也会变，不再只有高度）。
       *
       * 旧版只处理"高度变大 → 底部定位的窗口重新贴底"。现在卡片会因为长昵称
       * 自适应加宽，如果只 setSize 不重算 X，右上角的卡片会从右边长出屏幕 ——
       * 而它本来就是贴边显示的。四个边角与居中都按新尺寸重算，宽度和高度任一变化
       * 都会走到这里。
       */
      const [newW, newH] = win.getSize();
      if (Math.round(newW) !== Math.round(prevSize[0]) || Math.round(newH) !== Math.round(prevSize[1])) {
        void (async () => {
          try {
            const position = (await ConfigService.getInstance().get("notificationPosition")) || "top-right";
            const workArea = screen.getDisplayMatching(win.getBounds()).workArea;
            const padding = 20;
            const [winX, winY] = win.getPosition();
            let nextX = winX;
            let nextY = winY;
            if (position === "top-right" || position === "bottom-right") {
              nextX = workArea.x + workArea.width - newW - padding;
            } else if (position === "top-center") {
              nextX = workArea.x + (workArea.width - newW) / 2;
            } else {
              nextX = workArea.x + padding;
            }
            if (position === "bottom-left" || position === "bottom-right") {
              nextY = workArea.y + workArea.height - newH - padding;
            } else {
              nextY = workArea.y + padding;
            }
            if (Math.round(nextX) !== winX || Math.round(nextY) !== winY) {
              win.setPosition(Math.floor(nextX), Math.floor(nextY));
            }
          } catch { /* noop */ }
        })();
      }
    }
  });

  // 'notification-clicked' 在 main.ts 中处理 (导航)
}