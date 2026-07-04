<p align="right"><a href="README.en.md">English</a> · <b>中文</b></p>

<div align="center">

<img src="assets/codexdesk.svg" width="96" height="96" alt="Codex Desk" />

# Codex Desk

**一个聚焦会话管理和公式阅读的 Codex Linux 桌面端。**

Codex Desk 刻意做得很克制：管理和导出本地 Codex 会话，并把 Markdown 与公式排好版。
它不想把一个历史查看器做成另一个 Git 面板、项目管理器或复杂集成平台。

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

现在很多 AI 桌面产品做得很满：Git、IDE 面板、项目管理、仪表盘、聊天、自动化全都往里放。
这些东西不一定没用，但对很多用户来说会变复杂，尤其是不熟 Git、不想理解底层文件结构的人。

Codex Desk 只围绕两个核心需求做：

1. **会话管理和导出** —— Codex CLI 会把很有价值的工作记录存在本地 JSONL 会话和
   SQLite 索引里。Codex Desk 负责把这些历史变成可搜索、可阅读、可置顶、可归档、可删除、
   可导出的会话库，不要求用户理解 `sessions/`、`state_5.sqlite` 或 Git。
2. **公式排版** —— 很多科研、代码和分析会话里都有 Markdown、LaTeX 和公式。
   这些内容回看时应该是排版后的公式，而不是一堆原始 LaTeX 代码。

其他能力都是辅助：用量面板、明暗主题、就地提问/续跑，是为了让这两个流程更顺手，
不是为了把软件做得更复杂。

## 核心功能

- **统一会话库** —— 合并 SQLite 索引（`state_5.sqlite` 的 `threads` 表）和磁盘上的
  JSONL 回放文件，去重并按最近使用排序。任一来源缺失也照常工作。
- **实用的会话管理** —— 搜索、重命名、置顶、归档、折叠列表、复制 `codex resume`
  id、定位 JSONL 文件，以及安全删除到 `deleted_sessions/`。
- **导出 Markdown** —— 一键导到 `~/文档/codex-exports/`，方便归档、分享或长期保存。
- **完整对话渲染** —— GFM Markdown 加 KaTeX 公式渲染，支持 `$...$`、`$$...$$`、
  `\(...\)`、`\[...\]` 这类常见公式写法；代码块不会被误处理。

## 辅助功能

- **实时用量与配额** —— 总 token、速率限制窗口、最新 token 明细和每日用量图。
- **就地运行与续跑** —— 用 `codex exec` 发一条 prompt，或用 `codex exec resume`
  续跑选中的会话。
- **明暗主题** 和可拖拽调宽的会话栏。

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

`scripts/launch-codexdesk.sh` 会带着固定的 `CODEX_HOME` 启动应用。把一个 `.desktop`
条目的 `Exec` 指向它、`Icon` 指向 `assets/codexdesk.svg` 即可。

## 工作原理

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程  (electron/main.cjs)                          │
│   • 读取  CODEX_HOME/state_5.sqlite + sessions/**/*.jsonl     │
│   • 拉起 codex exec / app-server                              │
│   • sidecar 状态  (标题、置顶、归档)                           │
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

- 会话数据从你本地的 `CODEX_HOME` 读取。当前 Linux 启动脚本会显式设置 `CODEX_HOME`，
  需要时改成你自己的 Codex 目录；如果没有显式设置，应用会向上查找项目内的 `.codex`，
  最后才回退到应用目录下的 `.codex`。
- 改名会更新 Codex 的本地 `threads` 索引**并**写一份 app 独占的 sidecar 文件；
  置顶和归档状态也存在 sidecar 文件里。删除会把 JSONL 移到 `deleted_sessions/`
  并移除对应的索引行。
- 不往任何地方上传。导出默认到 `~/文档/codex-exports/`。

## 技术栈

`Electron 39` · `React 19` · `Vite 7` · `TypeScript` · `react-markdown` +
`remark-gfm` + `remark-math` + `rehype-katex`（KaTeX）· `lucide-react`。

## 状态

`v0.1.0` —— 早期版本，但已能日常使用。聚焦 Linux/X11。
