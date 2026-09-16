# WeportAI 页面重做 — 借用 DSH Web GUI 的设计语言

来源：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\index-*.css`
以及 `@deepseek-ai/dsh-client-ui-theme` / `dsh-client-ui-layout` 的 README 与 `lib/`。
**注意这是装了插件之后的版本**（`dsh-client-ui-*` 共 40 多个包），不是 DSH 原生骨架。

用户的要求：布局干净、玻璃质感、图标风格照抄这套（字体除外）。

## 一、DSH 的三层令牌结构（这是它"干净"的根源）

```
--dsw-static-*  原始色板      neutral-bluish-00 / 75 / 100 / 150 / 600 / 700 / 800 / 850 / 875 / 950 / 1000
--dsw-alias-*   语义别名      bg-base / bg-layer-1..3 / bg-overlay / bg-mask-1..3 / border-l1..l4 /
                              brand-primary / interactive-bg-hover|active / scrollbar-bg-l1|l2 /
                              toast-bg / tooltip-bg
--dsl-* / --dsh-*  组件级     terminal-radius / code-block-radius / read-gutter / file-type-*
```

关键点：**明暗两套是同一批别名换值**，组件只读别名。`body[data-ds-dark-theme]` 切换。
Weport 现状是 `--bg / --panel / --elevated / --line` 混着写死的 rgba，页面各自发明层级，
这正是"面板看起来不成体系"的来源。

### 要借的层级模型

| DSH 别名 | 含义 | Weport 对应 |
|---|---|---|
| `bg-base` | 窗口底色 | `--bg` |
| `bg-layer-1` | 左栏 / 卡片 | `--panel`（扩成三层） |
| `bg-layer-2` | 面板内嵌块 | `--elevated` |
| `bg-layer-3` | 弹层 / 菜单 | 新增 `--layer-3` |
| `bg-overlay` | 模态底 | 新增 |
| `bg-mask-1..3` | 0.24 / 0.12 / 0.48 黑遮罩 | 新增（现在各处写 `rgba(0,0,0,.62)`） |

## 二、用"发丝线 + 双层柔影"代替 1px 边框

DSH 的做法（`gradient-shadow-text.css`）：

- `--dsw-elevation-stroke`：0.5px 发丝线，颜色走可重绑的 `--dsw-elevation-stroke-color`
- `--dsw-elevation-panel / prominent / soft`：在发丝线之上叠两层极淡的柔和阴影
- **抬升的表面 `border: 0`**，不占布局的轮廓

Weport 现在每个面板都是 `1px solid var(--line)`，卡片一多就是一堆等权重的灰框。
这是"看起来乱"最直接的原因，也是这次要换掉的核心。

## 三、玻璃的用法比我们克制

DSH 只用三处 `backdrop-filter`：`var(--dsw-mask-blur)`、`blur(2px)`、`blur(6px)`。
Weport 现在是 `backdrop-filter: blur(14px)`，全屏视频背景下每帧重算（已在
`data-bg-kind='video'` 时关掉）。AI 页面只给弹层与输入条用 6px。

## 四、圆角：squircle

```css
@supports (corner-shape: superellipse(1.5)) {
  * { --dsw-corner-shape: superellipse(1.5); corner-shape: var(--dsw-corner-shape) }
}
```
`border-radius: 50%` 的圆形与胶囊要配 `corner-shape: round`，否则会被压变形。
代码块 / 终端 / 只读视图统一 12px 半径。

## 五、要落到 WeportAI 页面的布局

DSH 的结构是"每个区域一个插件"：`ui-sidebar` / `ui-conversation` / `ui-sidebar-right` /
`ui-layout`（AppFrame + columns）。WeportAI 已经是三栏，映射关系：

| DSH 区域 | WeportAI 现状 | 重做后 |
|---|---|---|
| 左栏（会话/项目） | 对话列表 | 保留，换成 layer-1 表面 + 发丝线 |
| 中间（conversation） | 消息流 | 消息卡改成"无边框 + 抬升阴影"，工具调用块用 12px 圆角卡片 |
| 右栏（文件/记忆） | 记忆 · 笔记 | 保留，文件行改成 DSH 那种一行式（名字 + 元数据右对齐） |
| composer | 底部输入条 | 玻璃 6px + 抬升阴影，附件/模型/发送收成一条工具行 |
| — | — | 新增顶部工具栏：会话标题 + 模型 chip + 上下文/缓存进度（DSH 的 header 语汇） |

## 六、图标

DSH 用线性图标、统一 1.5–1.8 描边、尺寸档位 12/14/16。Weport 已经是 lucide，
但尺寸档位混乱（10/11/12/13/14/15/16/17 都有）。重做时收敛到 12/14/16。

## 七、不做的事

- 不换字体（用户明确说字体不动）。
- 不照抄 DSH 的插件运行时（那是浏览器插件架构，Electron 里没必要）。
- 不引入新的状态库。
