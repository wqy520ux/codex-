# Implementation Plan: codex-responses-adapter

## Overview

按照 design.md 的模块划分逐层构建 TypeScript / Node.js 20+ 工程：先搭骨架与共享类型，随后实现互不依赖的纯函数模块（配置解析、掩码、模型路由、请求/响应/错误翻译、SSE 状态机），再实现 IO 层（上游 undici 客户端、失败事件补投存储、Fastify 中间件与路由），最后串联 CLI、集成测试与分发物。23 条 Correctness Properties 每条对应一个属性测试子任务，紧贴其被验证的实现代码，便于早期捕获回归。

## Tasks

- [x] 1. 项目骨架与核心类型
  - [x] 1.1 初始化 npm + TypeScript 工程与依赖
    - 建立 `package.json`、`tsconfig.json`、`vitest.config.ts`、`.eslintrc.cjs`、目录结构 `src/{types,config,utils,router,translator,client,store,ingress,cli}` 与 `tests/{unit,property,integration}`
    - 安装运行时依赖 `fastify`、`undici`、`ajv`、`ajv-formats`、`yaml`、`pino`、`commander`
    - 安装开发依赖 `typescript`、`vitest`、`fast-check`、`@types/node`、`execa`、`eslint`
    - 配置 `bin` 指向 `dist/cli/index.js`，`scripts` 覆盖 `build`、`test`、`lint`
    - _Requirements: 13.1, 13.2_

  - [x] 1.2 定义核心 TypeScript 类型
    - 在 `src/types/responses.ts` 定义 `ResponsesRequest`、`InputMessage`、`InputContentPart`、`FunctionTool`、`ToolChoice`、`ResponsesObject`、`ResponsesOutputItem`、`ResponsesEvent` 联合类型
    - 在 `src/types/chat.ts` 定义 `ChatCompletionsRequest`、`ChatMessage`、`ChatContentPart`、`ChatToolCall`、`ChatCompletionsResponse`、`ChatSseChunk`
    - 在 `src/types/error.ts` 定义 `OpenAIError` 与 `type` 字面量联合
    - 在 `src/types/config.ts` 定义 `Config`、`ProviderProfile`、`ModelMapping`、`LogConfig`、`ListenConfig`
    - _Requirements: 2.1-2.11, 3.1-3.4, 4.2-4.6, 6.1, 7.2, 9.2_

- [x] 2. 配置解析与序列化
  - [x] 2.1 实现 JSON Schema 与 `parseConfig`
    - 在 `src/config/schema.ts` 定义 Config JSON Schema（ajv + ajv-formats）
    - 在 `src/config/parse.ts` 实现 `parseConfig(text: string): Config`：yaml → object → schema 校验 → 失败时抛出带字段路径的 `ConfigValidationError`
    - 通过 ajv `additionalProperties: true` + 自定义遍历钩子收集未识别字段路径并以 warning 形式返回
    - _Requirements: 9.1, 9.2, 9.3, 9.6_

  - [x] 2.2 实现 `prettyPrintConfig`
    - 在 `src/config/prettyPrint.ts` 实现按每层字段字典序排序 + 2 空格缩进的 YAML 序列化
    - 对 `admin_key`、`providers[].api_key` 以 `maskSecret` 形式输出（为 Requirement 7.4 预留，真正实现见 3.1）
    - _Requirements: 9.4_

  - [x]* 2.3 为配置 round-trip 编写属性测试
    - **Property 17: 配置 round-trip**
    - **Validates: Requirements 9.4, 9.5**

  - [x]* 2.4 为配置校验失败退出编写属性测试
    - **Property 18: 配置校验失败必定非零退出**
    - **Validates: Requirements 9.3**

  - [x]* 2.5 为未识别字段 warning 编写属性测试
    - **Property 19: 未识别字段仅产生 warning**
    - **Validates: Requirements 9.6**

- [x] 3. 密钥与 PII 掩码工具
  - [x] 3.1 实现 `maskSecret` 与 `maskPii`
    - 在 `src/utils/mask.ts` 实现 `maskSecret(s)`：长度 ≤ 8 → `***`；否则 `s.slice(0,4) + "..." + s.slice(-4)`
    - 实现 `maskPii(text)`：对邮箱、中国大陆 11 位手机号、E.164 手机号、13–19 位连续数字（Luhn 长度近似）执行正则替换为 `***`
    - 两个函数均为纯函数，不依赖外部状态
    - _Requirements: 7.4, 10.5_

  - [x]* 3.2 为密钥脱敏格式编写属性测试
    - **Property 12: 密钥脱敏格式**
    - **Validates: Requirements 7.4**

  - [x]* 3.3 为 PII 遮蔽编写属性测试
    - **Property 22: PII 遮蔽**
    - **Validates: Requirements 10.5**

- [x] 4. 模型路由
  - [x] 4.1 实现 `resolveModel` 与 `ModelNotFoundError`
    - 在 `src/router/resolver.ts` 实现 `resolveModel(req, cfg): { profile, upstreamModel }`
    - 缺失/空串 model + 存在 `default_model` → 使用默认；未命中 → 抛出 `ModelNotFoundError`（携带状态码 404 与 `error.type=model_not_found`）
    - _Requirements: 6.2, 6.3, 6.4_

  - [x]* 4.2 为模型路由全面性编写属性测试
    - **Property 9: 模型路由的全面性**
    - **Validates: Requirements 6.2, 6.3, 6.4**

- [x] 5. 请求翻译（Responses → Chat Completions）
  - [x] 5.1 实现 `translateRequest`
    - 在 `src/translator/request.ts` 实现完整翻译：`instructions` → system 消息、`input` 字符串/数组 → `messages`、富文本 `input_text` 保序合并、`capabilities.vision` 门控 `input_image`（false 丢弃 + `logger.warn`）、`tools` 仅保留 `type="function"`、`tool_choice` 映射、采样参数映射（`max_output_tokens → max_tokens` 等）、`reasoning.effort` 经 `profile.reasoning_param_name` 条件映射、`model` 替换为 `upstreamModel`
    - _Requirements: 2.1-2.11_

  - [x] 5.2 实现请求前置校验
    - 在 `src/ingress/preValidate.ts` 实现 `validateResponsesRequestShape(body)`：JSON 合法性、`model` 非空、`input` 为字符串或数组、所有 `tools[].function.name` 非空
    - 多条约束同时违反时仍只返回一次 `{ ok: false, error: OpenAIError(type="invalid_request_error") }`
    - _Requirements: 2.12, 2.13_

  - [x]* 5.3 为请求往返等价编写属性测试
    - **Property 1: Responses 请求到 Chat Completions 请求的往返等价**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.9, 2.11, 5.1**

  - [x]* 5.4 为 reasoning.effort 条件映射编写属性测试
    - **Property 7: reasoning.effort 条件映射**
    - **Validates: Requirements 2.10**

  - [x]* 5.5 为请求前置校验完备性编写属性测试
    - **Property 8: 请求前置校验的完备性**
    - **Validates: Requirements 2.12, 2.13**

- [x] 6. 非流式响应翻译（Chat Completions → Responses）
  - [x] 6.1 实现 `translateResponse`
    - 在 `src/translator/response.ts` 构造 Responses 对象：`message.content` 非空 → `output` 追加 `type="message"`；遍历 `tool_calls` → `output` 追加 `type="function_call"`
    - 映射 `usage`：`prompt_tokens → input_tokens`、`completion_tokens → output_tokens`、`total_tokens → total_tokens`
    - `finish_reason` → status：`stop/tool_calls → completed`、`length/content_filter → incomplete`、其他/缺失 → `completed`（与 token 计数无关）
    - 缺失 `choices` 或 `choices[0].message=null` → 抛 `UpstreamShapeError`（502 upstream_error）
    - _Requirements: 3.1-3.6_

  - [x]* 6.2 为响应往返等价编写属性测试
    - **Property 2: Chat Completions 非流式响应到 Responses 响应的往返等价**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 5.2**

  - [x]* 6.3 为 finish_reason 映射独立性编写属性测试
    - **Property 6: finish_reason 到 status 的映射独立于 token 计数**
    - **Validates: Requirements 3.5**

- [x] 7. 错误映射
  - [x] 7.1 实现 `mapUpstreamError`
    - 在 `src/translator/errorMapper.ts` 按状态码映射：401→`invalid_api_key`、403→`permission_error`、404→`model_not_found`、429→`rate_limit_error`、其他 4xx→`invalid_request_error` 透传状态码、5xx→HTTP 502 `upstream_error` 并保留上游 `message`
    - 统一产出 `{ statusCode, error: OpenAIError }` 形状
    - _Requirements: 8.1, 8.2, 3.6_

  - [x]* 7.2 为上游错误映射编写属性测试
    - **Property 13: 上游错误状态码到 OpenAI 错误类型的映射**
    - **Validates: Requirements 8.1, 8.2, 3.6**

- [x] 8. Checkpoint - 核心纯函数模块
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. SSE 流式翻译状态机
  - [x] 9.1 实现 `StreamingState` 与 `stepStream`（常规事件路径）
    - 在 `src/translator/stream.ts` 定义 `StreamingState` 与 `ToolCallAccumulator`
    - 实现 `stepStream(state, chunk) → { state, events }`：初始发 `response.created`；文本增量 → 按需先发 `response.output_item.added(type=message)` 再发 `response.output_text.delta`；工具调用增量 → 按 tool_call 索引维持稳定 `item_id`，按需先发 `response.output_item.added(type=function_call)` 再发 `response.function_call_arguments.delta`
    - 仅在上游 `finish_reason != null` 时发 `function_call_arguments.done` / `output_text.done` / `output_item.done` / `response.completed`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 9.2 在 `stepStream` 中实现 `upstream_error` 与 `response.failed` 强化投递
    - 处理 `chunk = "upstream_error"` 分支：构造 `response.failed` 事件，先序列化到字节缓冲，再执行写入 → flush → close
    - 对外暴露 `serializeFailedEvent(error)` 以便 ingress 登记到 `FailedEventReplayStore`
    - _Requirements: 4.8, 4.9_

  - [x]* 9.3 为流式/非流式重建等价编写属性测试
    - **Property 3: 流式到非流式的重建等价**
    - **Validates: Requirements 4.3, 4.4, 4.5, 5.3**

  - [x]* 9.4 为流式结束信号不可推断编写属性测试
    - **Property 4: 流式结束信号不可推断**
    - **Validates: Requirements 4.6**

  - [x]* 9.5 为流式 `item_id` 稳定性编写属性测试
    - **Property 5: 流式事件 `item_id` 稳定性**
    - **Validates: Requirements 4.4, 4.5**

- [ ] 10. 失败事件补投存储
  - [x] 10.1 实现 `FailedEventReplayStore`
    - 在 `src/store/failedReplay.ts` 实现以 `request_id` 为键、TTL 60s 的内存表；支持 `put(requestId, failedEventBytes)`、`takeIfFresh(requestId)`（命中即一次性消费）
    - 使用懒清理 + 显式 `sweep()` 避免定时器泄漏
    - _Requirements: 4.9_

  - [x]* 10.2 为 `response.failed` 补投窗口编写属性测试
    - **Property 16: `response.failed` 事件补投窗口**
    - **Validates: Requirements 4.8, 4.9**

- [ ] 11. 上游 HTTP 客户端
  - [x] 11.1 实现 `UpstreamClient`
    - 在 `src/client/upstream.ts` 以 `undici.Pool` 每个 `ProviderProfile` 独立连接池（`max_connections` 默认 16）
    - 非流式：`max_retries` 次指数退避，退避毫秒 `Math.min(500 * 2 ** (n - 1), 4000)`，总调用次数 `N + 1`
    - 流式：不自动重试；以 `AsyncIterable<ChatSseChunk>` 产出解析后的 `data:` 块
    - Headers 超时：`timeout_ms`（默认 60000）未到首字节 → 主动 `AbortController.abort()` 并返回 504 `upstream_timeout`；晚到响应丢弃
    - 接受外部 `signal`，客户端断开时在 1 秒内向上游广播取消并释放连接
    - 始终以 `Authorization: Bearer <profile.api_key>` 头发出请求；不得透传 `admin_key`
    - _Requirements: 4.7, 6.6, 7.3, 8.3, 8.4, 8.5, 11.3_

  - [x]* 11.2 为指数退避调度编写属性测试
    - **Property 14: 指数退避重试调度表**
    - **Validates: Requirements 8.4, 8.5**

  - [x]* 11.3 为超时与晚到丢弃编写属性测试
    - **Property 15: 超时与晚到响应丢弃**
    - **Validates: Requirements 8.3**

- [x] 12. Ingress 中间件与结构化日志
  - [x] 12.1 实现 RequestId 中间件
    - 在 `src/ingress/requestId.ts` 注册 `onRequest` 钩子：生成 UUID v4，附加到 `req.requestId`、`reply.header("X-Request-Id", id)` 与 pino child logger context
    - _Requirements: 10.1_

  - [x] 12.2 实现 AuthMiddleware 与回环绑定策略
    - 在 `src/ingress/auth.ts` 实现：`path === "/healthz"` 放行；`admin_key` 为空 → 拒绝非回环连接（`127.0.0.1/::1`）；否则要求 `Authorization: Bearer <admin_key>`，不等值 → 401
    - 401 响应体严格包含 `message`（非空）、`type="invalid_api_key"`、`param`、`code`，`Content-Type: application/json; charset=utf-8`
    - 暴露 `resolveBindHost(cfg): string` 供 server 启动时选择监听地址
    - _Requirements: 7.1, 7.2, 7.5_

  - [x] 12.3 实现并发限流器
    - 在 `src/ingress/limiter.ts` 维护在途计数，超过 `listen.max_concurrency`（默认 64）→ 返回 HTTP 503 `error.type=adapter_overloaded`
    - 写入客户端失败时仍通过 pino 输出一条结构化过载日志（`error.type=adapter_overloaded`），确保可观测性
    - _Requirements: 11.2_

  - [x] 12.4 实现访问日志与录制写入
    - 在 `src/ingress/accessLog.ts` 注册 `onResponse` 钩子：输出 JSON 结构化日志 `{ request_id, model, provider, stream, status_code, latency_ms }`
    - `log.level === "debug"` 额外输出转换前后的字段摘要（不含 prompt 文本）
    - `log.record_bodies === true` 时以 NDJSON 写入 `log.record_dir`，每行含 `recorded_at`、`request_id`、`direction`、`body`；body 经 `maskPii` 处理
    - _Requirements: 10.2, 10.3, 10.4_

- [x] 13. Ingress 路由与生命周期
  - [x] 13.1 实现 `POST /v1/responses` 处理器
    - 在 `src/ingress/server.ts` 注册路由：串联 `requestId → auth → limiter → preValidate → resolveModel → translateRequest → UpstreamClient.send`
    - 非流式分支：`translateResponse` → JSON 响应
    - 流式分支：设置 `Content-Type: text/event-stream`，驱动 `stepStream` 状态机输出事件；错误时走 9.2 强化投递流程并在失败时登记到 `FailedEventReplayStore`
    - 首个事件前检查 `FailedEventReplayStore.takeIfFresh(requestId)`：命中则先补投 `response.failed`
    - _Requirements: 1.2, 2.12, 4.1, 4.7, 4.8, 4.9, 6.2_

  - [x] 13.2 实现 `GET /v1/models`、`GET /healthz`、`ALL /v1/responses` 非 POST 方法处理
    - `/v1/models` 读取 `cfg.model_mappings` 输出 OpenAI 兼容格式列表
    - `/healthz` 100ms 内返回 200 `{ status: "ok" }`
    - 使用 Fastify `onRoute` 或显式处理器对 `/v1/responses` 非 POST 方法返回 405 + OpenAI 风格错误体
    - _Requirements: 1.3, 1.4, 1.5_

  - [x] 13.3 实现全局错误处理与优雅关停
    - 注册 `setErrorHandler`：未捕获异常 → HTTP 500 `adapter_internal_error`，完整堆栈写 `error` 级日志
    - 监听 `SIGINT`/`SIGTERM`：停止接受新请求，最多等待 10 秒让在途请求完成后退出
    - _Requirements: 8.6, 11.4_

  - [x]* 13.4 为上游鉴权来源唯一性编写属性测试
    - **Property 10: 上游鉴权来源的单一性**
    - **Validates: Requirements 6.6, 7.3**

  - [x]* 13.5 为本地鉴权严格错误体编写属性测试
    - **Property 11: 本地鉴权与错误体严格形状**
    - **Validates: Requirements 7.1, 7.2**

  - [x]* 13.6 为 `X-Request-Id` 形状/唯一性编写属性测试
    - **Property 20: `X-Request-Id` 形状与唯一性**
    - **Validates: Requirements 10.1**

  - [x]* 13.7 为访问日志字段完备编写属性测试
    - **Property 21: 访问日志字段完备**
    - **Validates: Requirements 10.2**

  - [x]* 13.8 为并发过载可观测性编写属性测试
    - **Property 23: 并发过载错误语义可观测**
    - **Validates: Requirements 11.2**

  - [x]* 13.9 编写 ingress 集成测试
    - 客户端断开 → 上游 1 秒内收到 abort（Requirements 4.7）
    - 32 并发长连接下响应正确（Requirements 11.1）
    - SIGTERM 后 10 秒内优雅关停（Requirements 11.4）
    - `/healthz` 在 100ms 内返回（Requirements 1.4）
    - 未配置 `admin_key` 时仅接受回环地址连接（Requirements 7.5）
    - _Requirements: 1.4, 4.7, 7.5, 11.1, 11.4_

- [x] 14. Checkpoint - Ingress 与上游客户端贯通
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. CLI 与启动鲁棒性
  - [x] 15.1 实现 `codex-responses-adapter` CLI
    - 在 `src/cli/index.ts` 使用 `commander` 注册 `start [--config <path>]`、`config print [--config <path>]`、`config check <path>`、`validate --record <path>`
    - 默认配置路径 `~/.codex-responses-adapter/config.yaml`，可被 `--config` 覆盖
    - `config check` 执行 parse → schema validate → pretty-print → parse → 深度比较，失败时打印差异路径
    - `validate --record` 按 `request_id` 分组录制 NDJSON，驱动 Requirement 5.1/5.2/5.3 round-trip 校验
    - 任意启动阶段失败（schema 校验、端口占用、配置不可读、api_key 解密失败等）→ 非零退出码 + 输出失败阶段与原因到 stderr；即使校验失败后触发次生错误，退出码仍保持非零
    - _Requirements: 5.4, 9.1, 9.3, 9.3a, 9.3b, 9.4, 9.5, 13.2_

  - [x]* 15.2 为 CLI 子命令编写集成测试
    - 使用 `execa` 构建后执行 `start`（1 秒内监听）、`config print`（快照比较）、`config check`（合法/非法两条）、`validate --record`（合法录制与一处字段不一致录制）
    - _Requirements: 9.3, 9.4, 9.5, 13.2_

- [x] 16. 打包与文档
  - [x] 16.1 编写 `Dockerfile`
    - 基于 `node:20-alpine`，多阶段构建，`ENTRYPOINT ["node","dist/cli/index.js","start","--config","/etc/codex-responses-adapter/config.yaml"]`
    - 支持 `-v` 挂载配置文件目录
    - _Requirements: 13.3_

  - [x] 16.2 编写 README 三平台快速开始
    - 覆盖 Windows、macOS、Linux 的安装、生成示例配置、启动、将 Codex CLI 指向 Adapter 的命令
    - _Requirements: 13.4_

  - [x] 16.3 编写 `docs/cc-switch.md` 示例片段
    - 展示如何将 Adapter 注册为 cc switch 的 Codex 后端条目
    - _Requirements: 12.1, 12.2, 12.3_

- [x] 17. 最终 Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- 标记 `*` 的子任务为可选测试任务，核心实现任务从不标记为可选。
- 每个 property 独占一个子任务，并在实现任务旁就近放置，便于早期捕获回归。
- `translateRequest`、`translateResponse`、`stepStream`、`Config_Parser`、`Error_Mapper` 均为纯函数，单元覆盖率目标 ≥ 95%；IO 层以 undici `MockAgent` + Fastify `inject` 做集成测试。
- Checkpoints 设置在核心纯函数完成（任务 8）、Ingress 串联完成（任务 14）、全部任务结束（任务 17）三处，确保分阶段验证。
- 所有属性测试使用 `fast-check`，`numRuns` 默认 100，涉及状态机/复杂结构的提升到 200–500；测试文件以 `tests/property/<property-n>.test.ts` 命名，首行注释标注 `Feature: codex-responses-adapter, Property N: ...`。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.2", "3.1", "4.1", "5.1", "5.2", "6.1", "7.1", "9.1", "10.1", "11.1", "12.1", "12.2", "12.3", "12.4"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.5", "3.2", "3.3", "4.2", "5.3", "5.4", "5.5", "6.2", "6.3", "7.2", "9.2", "11.2", "11.3"] },
    { "id": 4, "tasks": ["9.3", "9.4", "9.5", "10.2", "13.1"] },
    { "id": 5, "tasks": ["13.2"] },
    { "id": 6, "tasks": ["13.3"] },
    { "id": 7, "tasks": ["13.4", "13.5", "13.6", "13.7", "13.8", "13.9", "15.1"] },
    { "id": 8, "tasks": ["15.2", "16.1", "16.2", "16.3"] }
  ]
}
```
