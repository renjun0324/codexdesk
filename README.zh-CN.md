<p align="right"><a href="README.md">English</a> · <b>中文</b></p>

<div align="center">

<img src="assets/codexdesk.svg" width="96" height="96" alt="Codex Desk" />

# Codex Desk

**一个快速的 Linux 桌面端，管理你本地的 Codex CLI 历史。**

浏览、搜索、阅读、重命名、导出每一个 Codex 会话——还带实时 token 与配额统计、
内置的 prompt 运行器——全程不用碰终端。

<sub>Electron · React 19 · Vite · TypeScript</sub>

</div>

---

<div align="center">
  <img src="assets/screenshots/overview.png" width="900" alt="Codex Desk 总览" />
  <br/>
  <sub>三栏工作区：会话列表 · 渲染后的对话 · 实时用量。</sub>
</div>

---

## 为什么做这个

Codex CLI 把每个会话都写进 `~/.codex`——JSONL 回放文件加一个 SQLite 索引。
这些历史信息很丰富，但在终端里基本看不见。Codex Desk 把它变成一个真正的桌面应用：
左边是可搜索的会话库，中间是完整渲染的对话（Markdown + LaTeX），右边是账户用量，
还能就地续跑或新起一次运行。

## 功能

- **统一会话库** —— 合并 SQLite 索引（`state_5.sqlite` 的 `threads` 表）和磁盘上的
  JSONL 回放文件，去重并按最近使用排序。任一来源缺失也照常工作。
- **完整对话渲染** —— 用 `react-markdown` + GFM 渲染 Markdown，用 `remark-math` +
  KaTeX 渲染数学公式。读起来就是真实的对话，不是原始 JSON。
- **搜索与筛选** —— 在标题、id、预览、工作目录、模型上即时筛选；可选显示归档会话。
- **改名不回退** —— 自定义标题存进 app 独占的 sidecar 文件，这样正在运行的 Codex
  会话不会在下一回合把它覆盖掉。（`threads.title` 这一列归 Codex 所有、会被它重新生成——
  Codex Desk 是绕开它来做的。）
- **安全删除** —— JSONL 被移到 `deleted_sessions/`（可恢复），同时清理索引行。
  什么都不会被彻底销毁。
- **实时用量与配额** —— 总 token、各时间窗的速率限制、最新 token 明细
  （输入/输出/缓存/推理）、每日用量图，数据来自 `codex app-server`，本地会话总量作兜底。
- **就地运行与续跑** —— 用 `codex exec` 发一条 prompt，或用 `codex exec resume`
  续跑选中的会话，事件流式回显到面板里。
- **导出 Markdown** —— 一键导到 `~/文档/codex-exports/`。
- **明暗主题**、可拖拽调宽的会话栏、多 `CODEX_HOME` 支持。

## 截图

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/screenshots/usage.png" alt="用量与配额面板" />
      <p align="center"><sub><b>用量与配额</b> —— token、速率限制窗口、每日图表</sub></p>
    </td>
    <td width="50%" valign="top">
      <img src="assets/screenshots/composer.png" alt="Prompt 编辑器" />
      <br/><br/>
      <p align="center"><sub><b>编辑器</b> —— 发一条 prompt 或续跑当前会话</sub></p>
    </td>
  </tr>
</table>

## 安装与运行

环境要求：**Node 18+**、`PATH` 里有 **Codex CLI**、以及 `sqlite3`
（CLI 不可用时会用内置的 `python3` 兜底）。

```bash
npm install
npm run build
npm start
```

前端热重载开发（Vite，改完即生效，不用重新 build）：

```bash
npm run dev
```

### 桌面启动器（Linux）

`scripts/launch-codexdesk.sh` 会带着同步好的 `CODEX_HOME` 启动应用。把一个 `.desktop`
条目的 `Exec` 指向它、`Icon` 指向 `assets/codexdesk.svg` 即可。

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程  (electron/main.cjs)                          │
│   • 读取  ~/.codex/state_5.sqlite  + sessions/**/*.jsonl      │
│   • 拉起 codex exec / app-server                              │
│   • sidecar 标题覆盖  (codexdesk-title-overrides.json)        │
└───────────────▲───────────────────────────┬──────────────────┘
                │ 上下文隔离的 IPC           │ window.codexDesk.*
        ┌───────┴───────┐          ┌─────────▼─────────┐
        │ preload.cjs   │          │ React 渲染进程     │
        │ (安全桥接)     │          │ (Vite build → dist)│
        └───────────────┘          └───────────────────┘
```

渲染进程从不直接碰文件系统或子进程——一切都走 preload 暴露出来的一小组明确的 IPC
接口（`sessions:*`、`usage:get`、`codex:run`、`shell:*`）。

## 数据与隐私

- 会话数据从你本地的 `CODEX_HOME`（默认 `~/.codex`）读取。
- 改名会更新 Codex 的本地 `threads` 索引**并**写一份 app 独占的 sidecar 文件；
  删除会把 JSONL 移到 `deleted_sessions/` 并移除对应的索引行。
- 不往任何地方上传。导出默认到 `~/文档/codex-exports/`。

## 技术栈

`Electron 39` · `React 19` · `Vite 7` · `TypeScript` · `react-markdown` +
`remark-gfm` + `remark-math` + `rehype-katex`（KaTeX）· `lucide-react`。

## 状态

`v0.1.0` —— 早期版本，但已能日常使用。聚焦 Linux/X11。
