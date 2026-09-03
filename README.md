# DSH Archive Manager 插件 (Codex-style 归档管理)

中文 | [English](README.en.md)

为 DeepSeek Harness (DSH) Web 界面提供与 Codex 1:1 一致的**会话归档管理**功能，支持在设置页中直观查看、搜索/筛选、**预览对话内容**、一键取消归档以及彻底删除归档会话。

当前版本要求 DSH `>=0.1.2-alpha.2`，并支持通过 `DSH_HOME` 指定 DSH 数据目录。

[![npm version](https://img.shields.io/npm/v/@mlgbnb/dsh-archive-manager.svg)](https://www.npmjs.com/package/@mlgbnb/dsh-archive-manager)
[![npm downloads](https://img.shields.io/npm/dm/@mlgbnb/dsh-archive-manager.svg)](https://www.npmjs.com/package/@mlgbnb/dsh-archive-manager)

![DSH Archive Manager 归档管理设置与会话列表](docs/images/archive-manager.png)

---

## 🌟 核心特性

1. **Codex 1:1 视觉与交互规范**：
   - 卡片外观保持 DSH 官方卡片统一规范（深灰背景、12px 圆角、矢量箭头旋转动效），仅在**设置 -> 插件**选项中加载；
   - 展开后提供顶层搜索栏（`搜索已归档聊天`）、排序筛选（`全部聊天` / `最早优先`）与项目筛选（`所有项目` / 各具体项目）。
2. **按项目分组与批量管理**：
   - 会话按所属工作区/项目自动分组展示，带有项目文件夹图标及对话计数；
   - 每个项目组支持 `···` 更多操作菜单，可一键「**删除项目中的全部内容**」。
3. **真实内容解析、预览与还原**：
   - 自动解析底层会话流，精确展示会话标题、创建时间、对话轮数与磁盘占用大小，日期格式与 Codex 一致（如 `2026年8月15日, 1:34`）；
   - **会话内容预览**：点击「查看内容」按钮，无需恢复即可在弹窗中直接浏览该会话最近 50 条用户/助手消息记录（自动清理会话日志中的系统注入文本）；
   - **取消归档**：点击「恢复会话」按钮，会话立即还原回原所属工作区列表，并通过 SSE 实时广播同步侧边栏；
   - **彻底删除**：点击「物理删除」按钮彻底删除会话元数据及磁盘数据文件，释放存储空间。
4. **零外部依赖的解压引擎**：
   - 内置基于 Node `zlib` 的 zstd 多帧解压引擎，可读取 `session.jsonl.zstd` 与未压缩的 `session.jsonl`，无需在系统中安装 `zstd` 命令行工具。
5. **实时双向同步（Live Sync）**：
   - 卡片展开时自动监听侧边栏归档变动，在工作区侧边栏归档或恢复会话时，归档管理列表自动无感同步更新。

---

## 📦 如何安装与配置到 DSH

DSH 采用 Cordis 模块化微内核架构，你可以通过以下方式安装该插件：

### 环境要求

- DSH `>=0.1.2-alpha.2`
- Web Profile
- Node.js 内置 `zlib`（无需额外安装 `zstd` 命令行工具）

### 方法一：通过 NPM 线上源安装（推荐）

#### 1. 使用 DSH 官方 CLI 命令一键安装

```bash
dsh plugin --profile web add -w @mlgbnb/dsh-archive-manager
```

如需固定当前版本，可执行：

```bash
dsh plugin --profile web add -w "@mlgbnb/dsh-archive-manager@1.0.10"
```

#### 2. 或者在 Web Profile 目录下通过 npm/pnpm 安装

```bash
# 已设置 DSH_HOME 时
cd "$DSH_HOME/profiles/web"
# 未设置 DSH_HOME 时
cd ~/.dsh/profiles/web
npm i @mlgbnb/dsh-archive-manager
# 或使用 pnpm
pnpm add -w @mlgbnb/dsh-archive-manager
```

安装完成后，请确认 `$DSH_HOME/profiles/web/package.json`（未设置 `DSH_HOME` 时为 `~/.dsh/profiles/web/package.json`）中的 `dsh.profile.bundles` 数组已包含 `@mlgbnb/dsh-archive-manager`：

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@mlgbnb/dsh-archive-manager": "^1.0.10"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@mlgbnb/dsh-archive-manager"
      ]
    }
  }
}
```

---

### 方法二：通过本地源码目录（Link 方式）安装

如果你在本地开发该插件，可以使用本地链接方式安装：

```bash
# 将本地插件目录以 link 方式添加至 web profile 的依赖中
dsh plugin --profile web add -w "link:/path/to/dsh/plugin/dsh-archive-manager"
```

> **注意**：如果执行 `add` 后启动报错提示子包重复声明，请检查 `$DSH_HOME/profiles/web/package.json`（未设置 `DSH_HOME` 时为 `~/.dsh/profiles/web/package.json`）中的 `dsh.profile.bundles` 数组，确保其中仅包含根包（如 `@mlgbnb/dsh-archive-manager`、`@linxin666/dsh-web-ui-all` 等），避免包含子组件包。

---

## 🚀 启动与体验

启动 DSH Web 服务：

```bash
dsh --profile web
# 或者
dsh web
```

打开浏览器访问 [http://127.0.0.1:3080/](http://127.0.0.1:3080/)，点击侧边栏底部的齿轮图标进入**设置 -> 插件**，即可看到「归档管理」卡片。

---

## 📂 项目结构

```text
dsh-archive-manager/
├── cordis.patch.yml   # Cordis 插件 Profile 声明补丁
├── package.json       # 模块清单与依赖声明
├── README.md          # 中文说明文档
├── README.en.md       # English documentation
├── docs/
│   └── images/        # 说明文档截图与预览图
├── lib/
│   ├── index.js       # Host 端（提供 /api/dsh-archive-manager/* 接口与 workspaceRegistry 交互）
│   └── client.js      # Client 端（Codex 风格卡片交互、项目分组、搜索筛选、预览弹窗、删除与还原逻辑）
└── src/
    └── index.ts       # TypeScript 伴生源文件（类型声明与 Host 入口说明）
```

插件运行时会读取 DSH 的 `storages/workspace.json`、`storages/session_projcache.json` 和 `sessions/` 目录。数据根目录由 DSH_HOME 路径解析规则决定，默认是 `~/.dsh`。

---

## 🔧 配置

### 受信主机 (trustedHosts)

当 DSH 通过反向代理（如 cloudflared、nginx、Caddy）对外提供 HTTPS 访问时，归档管理 API 会拒绝非 loopback 的 Host 头。插件会**自动继承** DSH 启动时 `--trusted-host` 参数指定的受信主机名，无需额外配置。

如需显式声明（覆盖自动继承），可在 `cordis.patch.yml` 中配置：

```yaml
- insert:
    - id: archive-manager
      name: '@mlgbnb/dsh-archive-manager'
      config:
        trustedHosts:
          - dsh.example.com
```

> **安全说明**：`trustedHosts` 仅在 `socket.remoteAddress` 为 loopback（127.0.0.1 / ::1）时生效——即反向代理或隧道已在本机与 DSH 之间建立 loopback 连接。直接暴露在公网接口上的 DSH 实例不会因为配置了 `trustedHosts` 而接受外部直连。

---
