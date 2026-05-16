# Codex 完美接入国产大模型

> **王小王 著作** · 不得用于二次改编贩卖 · 更多免费工具加 VX：YYYYFC0111

一键让 OpenAI Codex CLI / Codex 桌面版无缝使用国产大模型（DeepSeek、通义千问、小米 MiMo、豆包、Kimi）。无需改 Codex 源码，本地运行一个协议转换器即可。

## ✅ 已实测通过的大模型

| 模型厂商 | 模型名称 | 基础对话 | 工具调用 | 多轮对话 | 深度思考 | 并行工具 | 压力测试 |
|---|---|---|---|---|---|---|---|
| **DeepSeek（深度求索）** | deepseek-chat | ✓ | ✓ | ✓ 10轮 | ✓ | ✓ 5并发 | ✓ 8K上下文 |
| **Qwen（通义千问/阿里云）** | qwen-plus | ✓ | ✓ | ✓ 10轮 | — | ✓ 5并发 | ✓ 8K上下文 |
| **小米 MiMo** | mimo-v2.5-pro | ✓ | ✓ | ✓ 10轮 | ✓ Thinking Mode | ✓ 5并发 | ✓ 8K上下文 |
| **豆包（火山引擎）** | doubao-seed-2-0-lite | ✓ | ✓ | ✓ 10轮 | ✓ | ✓ 5并发 | ✓ 8K上下文 |
| **Kimi（月之暗面）** | kimi-k2.6 | ✓ | ✓ | ✓ 10轮 | ✓ | ✓ 5并发 | ✓ 8K上下文 |

**测试场景覆盖：**
- 10 轮连续工具调用链（function_call ↔ function_call_output 完整 round-trip）
- 5 个并发流式请求（无连接池死锁、无数据错乱）
- 8K token 长上下文 + 中文推理任务
- 中途客户端断开 → adapter 1 秒内清理资源
- 断开后立即新请求 → 无状态污染
- 并行工具调用（多个 function_call 合并为单条 assistant message）
- MiMo/豆包 Thinking Mode reasoning_content 双向透传

## 🚀 一键启动（30 秒上手）

### 完全没装过 Node.js？— 用一键安装脚本

**Windows：** 双击 `install-and-start.bat`
- 自动检测 Node.js 是否已装 + 版本是否 >= 20
- 没装就自动从国内镜像下载 LTS 并静默安装（约 1-2 分钟）
- 装完立即启动 adapter

**macOS / Linux：** `./install-and-start.sh`
- 自动用 brew / nvm 装 Node.js LTS
- 自动加 `npmmirror` 国内镜像
- 装完立即启动 adapter

### 已经装过 Node.js 20+？— 直接启动

**Windows：** 双击 `start.bat`

**macOS / Linux：** `./start.sh`

**任何平台：** `npm start`

启动后浏览器自动打开管理面板 `http://127.0.0.1:11434/admin/`：
1. 点 **Providers** 标签
2. 选择你要用的模型厂商，粘贴 API Key
3. 点 **测试连接** 验证
4. 把 Codex 指向 `http://127.0.0.1:11434/v1` 即可

## 📋 Codex 配置方法

### Codex CLI

```bash
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1
export OPENAI_API_KEY=any
codex --model gpt-4o
```

### Codex 桌面版

在 `~/.codex/config.toml` 中配置：

```toml
model_provider = "adapter"
model = "gpt-4o"

[model_providers.adapter]
name = "Adapter"
base_url = "http://127.0.0.1:11434/v1"
api_key = "any"
```

或使用 cc-switch 工具一键切换。

### 模型别名说明

Codex 发送的 model 名（如 `gpt-4o`）会被 adapter 映射到实际的国产模型。默认映射：

| Codex 发送的 model | 实际路由到 |
|---|---|
| `gpt-4o` | deepseek-chat |
| `gpt-4o-mini` | deepseek-chat |

你可以在 admin 面板的"模型映射"标签里自由修改，比如把 `gpt-4o` 指向 `mimo-v2.5-pro` 或 `kimi-k2.6`。

## 🖥️ Admin 管理面板

内置 Web 管理界面，运行在同一端口（无需额外服务）：

- **仪表盘** — 运行状态、最近 100 条请求、Codex CLI 配置片段
- **Providers** — 增删改查模型厂商，9 个国产 LLM 预设一键导入
- **测试连接** — 真实调用上游 API 验证 Key 是否有效
- **模型映射** — 管理 Codex 别名 → 实际模型的路由
- **设置** — 监听地址/端口、日志级别、admin_key 等

安全模型：无 admin_key 时仅 127.0.0.1 可访问（loopback 安全边界）。

## 📦 分享给别人

```bash
npm run package
```

生成 `release/codex-responses-adapter-v0.1.0.zip`（~307 KB），发给同事：
1. 解压
2. 双击 `start.bat`
3. 首次自动安装依赖（1-2 分钟）
4. 浏览器打开 → 粘贴 Key → 开干

## 🐳 Docker

```bash
docker build -t codex-adapter .
docker run --rm -v "$HOME/.codex-responses-adapter:/etc/codex-responses-adapter:ro" -p 11434:11434 codex-adapter
```

## 🔧 开发

```bash
npm install
npm run build
npm test        # 400 个测试（含 23 个属性测试）
npm run lint
npm start       # 一键启动
npm run package # 打包 zip
```

## 📄 技术特性

- TypeScript + Fastify + undici
- OpenAI Responses API ↔ Chat Completions 双向协议翻译
- SSE 流式事件完整转换（含 reasoning、content_part、function_call）
- 并行工具调用合并（多个 function_call → 单条 assistant message）
- MiMo/豆包 Thinking Mode reasoning_content 自动回传
- `developer` role 支持（Codex v0.130+）
- 配置热更新（admin 面板修改即时生效，无需重启）
- 23 个 Property-Based Tests + 17 个 Admin API 集成测试
- 5 家国产 LLM × 5 个压力场景 = 25 个生产级端到端验证

## 📞 联系方式

更多免费工具、使用问题、Bug 反馈：

**微信：YYYYFC0111**

---

**王小王 著作 · 不得用于二次改编贩卖**
