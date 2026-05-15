# Requirements Document

## Introduction

本功能构建一个协议中转适配器（以下称 Adapter），用于将 OpenAI Codex 生态最新使用的 `/v1/responses` 协议请求，转换为国内大模型普遍支持的 OpenAI 兼容 `/v1/chat/completions` 协议请求，并将上游的 Chat Completions 响应（含流式 SSE）还原为 Codex 端期望的 Responses 事件流。

Adapter 运行为本地 HTTP 服务，用户通过 `cc switch` 将 Codex 客户端的 API Base URL 指向 Adapter。Adapter 根据配置文件将不同的请求路由到不同的国内模型后端（如 DeepSeek、Qwen、GLM、Kimi、豆包、百川、MiniMax 等），并完成双向协议转换，包括非流式响应、流式响应、工具调用（function/tool calling）、system 消息、常用采样参数，以及错误映射。

首版目标为：在 Codex CLI 的日常编码会话（普通对话 + 工具调用 + 流式输出）场景下，使用任一国内主流 OpenAI 兼容模型能稳定完成会话，并保持与 `cc switch` 的协作一致。Adapter 同时提供配置文件 round-trip 校验、请求/响应录制回放校验等诊断能力，用于在协议演进过程中保障 Responses 与 Chat Completions 之间的语义一致性。

## Glossary

- **Adapter**: 本功能实现的中转适配器服务本体，对外暴露 Codex Responses 协议，对内调用国内模型的 Chat Completions 协议。
- **Codex**: OpenAI 发布的 Codex CLI 及其相关客户端生态，当前版本通过 `/v1/responses` 接口与后端模型交互。
- **Responses_API**: OpenAI 在 2024/2025 推出的新对话协议，端点为 `/v1/responses`，请求体包含 `input`、`instructions`、`tools`、`stream` 等字段；流式响应以命名 SSE 事件（如 `response.created`、`response.output_text.delta`、`response.completed`）输出。
- **Chat_Completions_API**: OpenAI 传统对话协议，端点为 `/v1/chat/completions`，请求体包含 `messages`、`tools`、`stream` 等字段；流式响应以 `data: {chunk}` 形式的 SSE 输出。
- **Upstream_Provider**: 提供 Chat Completions 兼容接口的国内模型服务商（DeepSeek、阿里 Qwen/通义千问、智谱 GLM、Moonshot Kimi、字节豆包、百川、MiniMax 等）。
- **Provider_Profile**: Adapter 配置中描述一个上游模型后端的条目，至少包含名称、Base URL、API Key、模型名映射、默认参数。
- **Model_Mapping**: 将 Codex 请求中的 `model` 字段值映射到具体 Upstream_Provider 及其真实模型 ID 的规则。
- **Request_Translator**: Adapter 内部将 Responses 请求转换为 Chat Completions 请求的模块。
- **Response_Translator**: Adapter 内部将 Chat Completions 响应（含 SSE 流）转换为 Responses 事件流的模块。
- **SSE**: Server-Sent Events，HTTP 长连接下的事件流传输协议。
- **Tool_Call**: 模型在响应中请求调用外部工具/函数的行为，在 Responses 协议中以 `response.output_item` 中 `type=function_call` 的条目表达，在 Chat Completions 协议中以 `choices[].message.tool_calls` 表达。
- **cc_switch**: 用户侧用于在多个 Codex/Claude 兼容后端之间切换 API Base URL 与凭据的工具。
- **Config_File**: Adapter 启动时加载的本地配置文件（YAML 或 JSON），定义监听端口、Provider_Profile 列表、Model_Mapping、日志级别等。
- **Admin_Key**: 客户端访问 Adapter 时使用的本地鉴权密钥，与上游真实 API Key 解耦。
- **Parser**: Adapter 中用于读取 Config_File 与录制文件，将其解析为内部对象表示的组件；同时承担 `adapter config check` 命令中的 parse/校验/round-trip 步骤。
- **Pretty_Printer**: Adapter 中用于将内部配置对象或录制对象序列化为规范化 YAML（字段字典序、统一 2 空格缩进）的组件，服务于 `adapter config print` 子命令以及 Requirement 5 / Requirement 9 的 round-trip 校验。

## Requirements

### Requirement 1: 对外暴露 Codex Responses 协议端点

**User Story:** 作为使用 Codex CLI 的开发者，我希望通过 `cc switch` 将 Codex 的 API Base URL 指向本地 Adapter，以便让 Codex 以为自己在与官方 Responses 服务通信。

#### Acceptance Criteria

1. THE Adapter SHALL 在启动后监听本地 HTTP 端口，默认端口为 8787，可通过 Config_File 覆盖。
2. THE Adapter SHALL 在路径 `/v1/responses` 上接受 HTTP POST 请求，并兼容 Codex 发送的请求头（包括 `Authorization`、`OpenAI-Beta`、`Content-Type: application/json`）。
3. WHEN 客户端请求 `GET /v1/models`, THE Adapter SHALL 返回当前配置中已声明的 Model_Mapping 列表，格式与 OpenAI `/v1/models` 响应一致。
4. WHEN 客户端请求 `GET /healthz`, THE Adapter SHALL 在 100ms 内返回 HTTP 200 与 JSON 体 `{"status":"ok"}`。
5. IF 请求到达的 HTTP 方法在 `/v1/responses` 上不是 POST, THEN THE Adapter SHALL 返回 HTTP 405 与 JSON 错误体，错误体结构与 OpenAI 错误格式一致。

### Requirement 2: Responses 请求到 Chat Completions 请求的转换

**User Story:** 作为 Adapter 的使用者，我希望 Codex 的 Responses 请求被正确翻译为国内模型可理解的 Chat Completions 请求，以便请求语义不丢失。

#### Acceptance Criteria

1. WHEN 收到合法的 Responses 请求, THE Request_Translator SHALL 将请求体中的 `instructions` 字段映射为一条 `role=system` 的消息，置于输出 `messages` 数组的最前。
2. WHEN 请求体中的 `input` 为字符串, THE Request_Translator SHALL 将该字符串映射为一条 `role=user` 的消息。
3. WHEN 请求体中的 `input` 为消息数组, THE Request_Translator SHALL 按数组顺序将每一条 `{role, content}` 项映射为 Chat Completions 的 `messages` 元素，并保留 `role` 取值 `user`、`assistant`、`system`、`tool`。
4. WHEN 请求体中某条输入项的 `content` 为富文本数组（包含 `input_text`、`input_image` 等条目）, THE Request_Translator SHALL 将文本条目合并为该消息的 `content` 文本，并保留原始顺序。
5. WHERE 上游 Provider_Profile 的 `capabilities.vision` 为 true, THE Request_Translator SHALL 将 `input_image` 条目转换为 Chat Completions 的 `image_url` 类型 content 片段。
6. WHERE 上游 Provider_Profile 的 `capabilities.vision` 为 false, THE Request_Translator SHALL 丢弃 `input_image` 条目，并在请求日志中记录一条 `warning` 级别日志。
7. WHEN 请求体中包含 `tools` 字段, THE Request_Translator SHALL 将每个 `type=function` 的工具定义转换为 Chat Completions 的 `tools[].function` 结构，保留 `name`、`description`、`parameters`（JSON Schema）。
8. WHEN 请求体中包含 `tool_choice` 字段, THE Request_Translator SHALL 将取值 `auto`、`none`、`required` 以及 `{type:"function", name:<N>}` 转换为 Chat Completions 等价的 `tool_choice` 取值。
9. WHEN 请求体中包含采样参数 `temperature`、`top_p`、`max_output_tokens`、`presence_penalty`、`frequency_penalty`, THE Request_Translator SHALL 将其分别映射为 Chat Completions 的 `temperature`、`top_p`、`max_tokens`、`presence_penalty`、`frequency_penalty`。
10. WHERE 请求体中包含 `reasoning.effort` 字段, THE Request_Translator SHALL 将该字段通过 Provider_Profile 的 `reasoning_param_name` 配置映射到上游对应参数；IF Provider_Profile 未配置该映射, THEN THE Request_Translator SHALL 在转换后的请求中省略该字段。
11. THE Request_Translator SHALL 将转换后的请求中的 `model` 字段替换为 Model_Mapping 中解析出的真实上游模型 ID。
12. THE Adapter SHALL 在进入协议转换之前对请求执行前置校验，校验项包括 JSON 合法性、必填字段 `model`、`input` 字段存在且类型为字符串或数组、`tools[].function.name` 非空。
13. IF 前置校验中任意一项失败, THEN THE Adapter SHALL 返回 HTTP 400 与 OpenAI 风格错误体，`error.type` 为 `invalid_request_error`，无论是否同时存在多个校验失败项。

### Requirement 3: Chat Completions 响应到 Responses 响应的转换（非流式）

**User Story:** 作为 Codex 客户端，我希望在请求设置 `stream=false` 时收到一个结构完整的 Responses JSON 对象，以便客户端按既有逻辑解析。

#### Acceptance Criteria

1. WHEN Adapter 收到上游 Chat Completions 非流式响应, THE Response_Translator SHALL 构造 Responses 响应对象，包含字段 `id`、`object="response"`、`created_at`、`status`、`model`、`output`、`usage`。
2. THE Response_Translator SHALL 将上游 `choices[0].message.content` 文本作为 Responses `output` 数组中一个 `type="message"` 条目，其 `content` 包含单个 `type="output_text"` 片段。
3. WHEN 上游响应中 `choices[0].message.tool_calls` 不为空, THE Response_Translator SHALL 为每一个 tool_call 在 `output` 数组中追加一个 `type="function_call"` 条目，保留 `call_id`、`name`、`arguments`。
4. THE Response_Translator SHALL 将上游 `usage.prompt_tokens`、`completion_tokens`、`total_tokens` 映射为 Responses 的 `usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens`。
5. THE Response_Translator SHALL 将上游 `choices[0].finish_reason` 映射为 Responses `status` 与 `output[].status`，映射规则为：`stop → completed`、`length → incomplete`、`tool_calls → completed`、`content_filter → incomplete`；映射规则与 `usage` 中的 token 计数无关，即使 `completion_tokens` 为 0 仍按上述规则执行。
6. IF 上游返回体缺少 `choices` 数组或 `choices[0].message` 为 null, THEN THE Response_Translator SHALL 返回 HTTP 502 与 OpenAI 风格错误体，`error.type` 为 `upstream_error`。

### Requirement 4: Chat Completions 流式响应到 Responses SSE 的转换

**User Story:** 作为 Codex 客户端，我希望在请求设置 `stream=true` 时收到与官方 Responses 一致的命名 SSE 事件流，以便在终端中实时展示生成内容与工具调用。

#### Acceptance Criteria

1. WHEN 请求体中 `stream=true`, THE Adapter SHALL 以 `Content-Type: text/event-stream` 响应，并保持连接直至上游结束或客户端断开。
2. THE Response_Translator SHALL 在上游流开始时首先发送一个 `event: response.created` 事件，其 `data` 为包含初始 `response` 对象（`status="in_progress"`）的 JSON。
3. WHEN 上游 SSE 块中 `choices[0].delta.content` 为非空字符串, THE Response_Translator SHALL 发送一个 `event: response.output_text.delta` 事件，`data.delta` 字段值为该增量文本。
4. WHEN 上游 SSE 块中 `choices[0].delta.tool_calls[i].function.arguments` 出现增量, THE Response_Translator SHALL 发送一个 `event: response.function_call_arguments.delta` 事件，按工具调用索引维持 `item_id` 稳定。
5. WHEN 上游某个 tool_call 的 `arguments` 累积到 finish_reason=tool_calls 边界, THE Response_Translator SHALL 发送一个 `event: response.function_call_arguments.done` 事件。
6. THE Response_Translator SHALL 仅在收到上游 SSE 中显式的 `choices[0].finish_reason` 非 null 值后才发送 `event: response.output_item.done` 与 `event: response.completed` 事件，不允许在上游未给出显式结束信号时推断完成。
7. WHEN 客户端提前断开连接, THE Adapter SHALL 在 1 秒内向上游连接发出取消信号并释放资源。
8. IF 上游在流式传输中返回 HTTP 错误或连接中断, THEN THE Response_Translator SHALL 发送一个 `event: response.failed` 事件，`data.response.error` 填充 OpenAI 风格错误对象，并关闭连接。
9. THE Response_Translator SHALL 为 `response.failed` 事件实现交付保障：在检测到上游错误后先将该事件序列化为字节缓冲区，再执行一次写入客户端、flush 与关闭；IF 写入期间发生连接错误, THEN THE Adapter SHALL 在下一个在线的后续客户端请求的首个事件之前，以 `response.failed` 形式补投同一 `request_id` 的错误结果，补投有效期为 60 秒。

### Requirement 5: Responses 与 Chat Completions 协议的往返一致性

**User Story:** 作为 Adapter 的维护者，我希望协议转换在结构上保持可逆性，以便通过回归测试确保字段与语义不会随版本演进丢失。

#### Acceptance Criteria

1. FOR ALL 合法 Responses 请求对象, THE Request_Translator 与一个配套的逆向转换器 SHALL 满足：对请求进行 `responses_to_chat → chat_to_responses` 后得到与原请求在指定字段集合（`model`、`instructions`、`input` 文本内容、`tools`、`tool_choice`、常用采样参数）上等价的对象（round-trip property）。
2. FOR ALL 合法非流式 Chat Completions 响应对象, THE Response_Translator 与一个配套的逆向转换器 SHALL 满足：对响应进行 `chat_to_responses → responses_to_chat` 后得到与原响应在指定字段集合（`message.content`、`tool_calls`、`finish_reason`、`usage`）上等价的对象。
3. FOR ALL 合法流式 Chat Completions 事件序列, THE Response_Translator SHALL 满足：将其转换为 Responses 事件序列，再将该事件序列按增量累积重建出的最终 Response 对象，与对相同上游非流式响应执行 Requirement 3 的结果在 `output` 文本与 `tool_calls` 字段集合上等价。
4. THE Adapter SHALL 提供一个命令行子命令 `adapter validate --record <path>`, 该命令读取录制的请求/响应对，执行第 1 至第 3 条的往返校验，并在失败时打印差异点。

### Requirement 6: 多上游模型路由与模型名映射

**User Story:** 作为用户，我希望在一个 Adapter 实例中配置多个国内模型后端，并通过请求中的 `model` 字段选择具体后端，以便不改动 Codex 即可切换模型。

#### Acceptance Criteria

1. THE Adapter SHALL 在启动时从 Config_File 加载 Provider_Profile 列表，每个条目至少包含 `name`、`base_url`、`api_key`、`models`（数组）、`capabilities`（对象）。
2. THE Adapter SHALL 根据请求中的 `model` 字段在 Model_Mapping 中查找对应的 Provider_Profile 与真实模型 ID。
3. WHERE Config_File 中定义了 `default_model`, IF 请求中的 `model` 字段缺失或为空字符串, THEN THE Adapter SHALL 使用 `default_model` 对应的映射。
4. IF 请求中的 `model` 字段在 Model_Mapping 中不存在, THEN THE Adapter SHALL 返回 HTTP 404 与 OpenAI 风格错误体，`error.type` 为 `model_not_found`。
5. THE Adapter SHALL 支持首版内至少一种 Provider_Profile `type` 取值：`openai_compatible`，覆盖 DeepSeek、阿里 Qwen（DashScope OpenAI 兼容端点）、智谱 GLM（OpenAI 兼容端点）、Moonshot Kimi、百川、MiniMax、字节豆包等满足 OpenAI 兼容协议的后端。
6. WHERE Provider_Profile 的 `type` 取值为 `openai_compatible`, THE Adapter SHALL 在发出上游请求时使用该 profile 的 `api_key` 作为 `Authorization: Bearer <api_key>` 头。

### Requirement 7: 本地鉴权与凭据隔离

**User Story:** 作为用户，我希望 Adapter 使用本地的 Admin_Key 校验来访请求，而不是把上游 API Key 暴露给 Codex 客户端，以便降低密钥泄露风险。

#### Acceptance Criteria

1. WHERE Config_File 中配置了非空的 `admin_key`, THE Adapter SHALL 对除 `/healthz` 外的所有请求要求 `Authorization: Bearer <admin_key>`。
2. IF 请求缺失或携带了错误的 Admin_Key, THEN THE Adapter SHALL 返回 HTTP 401 与严格 OpenAI 风格错误体，响应体顶层对象 SHALL 包含 `error` 字段，`error` 对象 SHALL 同时包含字段 `message`（string，非空）、`type`（string，取值 `invalid_api_key`）、`param`（string 或 null）、`code`（string 或 null），并以 `Content-Type: application/json; charset=utf-8` 响应。
3. THE Adapter SHALL 在转发给上游时使用 Provider_Profile 的 `api_key`，不得将客户端发来的 Admin_Key 透传到上游。
4. THE Adapter SHALL 在所有日志、错误信息、诊断命令输出中对 Admin_Key 与 Provider api_key 进行脱敏，仅保留前 4 位与后 4 位。
5. WHERE Config_File 中未配置 `admin_key`, THE Adapter SHALL 仅绑定到回环地址 `127.0.0.1`，不接受来自其他网络接口的连接。

### Requirement 8: 错误映射、超时与重试

**User Story:** 作为 Codex 客户端，我希望 Adapter 在上游异常时返回结构统一、含义明确的错误，以便客户端能区分重试类与终止类错误。

#### Acceptance Criteria

1. WHEN 上游返回 HTTP 4xx, THE Adapter SHALL 将其原始错误信息转写为 OpenAI 风格错误体并透传状态码，`error.type` 根据状态码映射：401 → `invalid_api_key`、403 → `permission_error`、404 → `model_not_found`、429 → `rate_limit_error`、其他 4xx → `invalid_request_error`。
2. WHEN 上游返回 HTTP 5xx, THE Adapter SHALL 返回 HTTP 502，`error.type` 为 `upstream_error`，并在 `error.message` 中保留上游原始消息。
3. WHERE Provider_Profile 配置了 `timeout_ms`, THE Adapter SHALL 在达到该时限仍未收到上游首字节时中断上游连接并返回 HTTP 504，`error.type` 为 `upstream_timeout`；默认值为 60000；IF 上游响应在 Adapter 已发出 504 之后才到达, THEN THE Adapter SHALL 丢弃该响应，不再改写已发送给客户端的结果。
4. WHERE Provider_Profile 配置了 `max_retries`（默认 2）且请求为非流式, IF 上游返回 HTTP 429 或 5xx, THEN THE Adapter SHALL 对同一请求最多重试 `max_retries` 次，采用指数退避，第 n 次退避时长计算公式为 `min(500 * 2^(n-1), 4000)` 毫秒，即当计算值超过 4000ms 时截断为 4000ms。
5. THE Adapter SHALL 不对流式请求执行自动重试，以避免向客户端发送重复事件。
6. IF Adapter 自身发生未捕获异常, THEN THE Adapter SHALL 返回 HTTP 500 与 OpenAI 风格错误体，`error.type` 为 `adapter_internal_error`，并在本地日志中记录完整堆栈。

### Requirement 9: 配置文件解析与校验

**User Story:** 作为用户，我希望 Adapter 使用一个清晰可编辑的本地配置文件描述监听端口、Provider 与模型映射，以便在不改代码的情况下管理后端。

#### Acceptance Criteria

1. THE Adapter SHALL 支持从默认路径 `~/.codex-responses-adapter/config.yaml` 加载 Config_File，并允许通过命令行参数 `--config <path>` 覆盖。
2. THE Config_File SHALL 使用 YAML 语法，语义字段包括 `listen`、`admin_key`、`default_model`、`log`、`providers`、`model_mappings`。
3. WHEN Adapter 启动, THE Adapter SHALL 对 Config_File 执行 JSON Schema 校验，校验失败时以非 0 状态码退出并输出第一个校验错误的路径与原因。
3a. IF Adapter 进程在任意启动阶段失败（包含但不限于 JSON Schema 校验失败、监听端口被占用、Config_File 路径不可读、Provider api_key 解密失败）, THEN THE Adapter SHALL 以非 0 状态码退出，并输出失败阶段与原因。
3b. THE Adapter SHALL 保证 JSON Schema 校验失败始终以非 0 状态码退出，即使在退出过程中触发次生错误。
4. THE Adapter SHALL 提供一个 Pretty_Printer 子命令 `adapter config print`, 该命令读取 Config_File 并输出等价的规范化 YAML（按字段字典序、统一缩进为 2 空格）到标准输出。
5. THE Adapter SHALL 提供一个 Parser 配套校验命令 `adapter config check <path>`, 对任意输入 Config_File 执行 parse → 校验 → pretty-print → parse 的流程，并断言两次 parse 得到的对象等价（round-trip property）。
6. WHERE Config_File 中包含未识别字段, THE Adapter SHALL 在启动日志中以 `warning` 级别记录该字段路径，但不阻止启动。

### Requirement 10: 日志与可观测性

**User Story:** 作为用户或维护者，我希望能够查看 Adapter 的请求日志、转换细节和上游调用情况，以便定位问题。

#### Acceptance Criteria

1. THE Adapter SHALL 为每一个入站请求分配一个 `request_id`（UUID v4），并在响应头 `X-Request-Id` 中返回。
2. THE Adapter SHALL 为每一个入站请求输出一条包含 `request_id`、`model`、`provider`、`stream`、`status_code`、`latency_ms` 字段的 JSON 结构化访问日志。
3. WHERE Config_File 中 `log.level` 为 `debug`, THE Adapter SHALL 额外记录转换前后的请求体摘要（字段列表与大小，不记录完整 prompt 文本内容）。
4. WHERE Config_File 中 `log.record_bodies` 为 true, THE Adapter SHALL 将完整请求体与响应体写入独立的录制文件目录，用于 Requirement 5 的往返校验。
5. THE Adapter SHALL 在所有日志中对消息内容中的邮箱、手机号、信用卡号等常见敏感字符串模式执行正则遮蔽（以 `***` 替代）。

### Requirement 11: 并发与资源占用

**User Story:** 作为本地单机用户，我希望 Adapter 在多请求并发下保持稳定，不影响 Codex 使用体验。

#### Acceptance Criteria

1. THE Adapter SHALL 支持至少 32 个并发 HTTP 长连接，空闲内存占用不超过 200MB。
2. WHEN 并发入站请求达到 `listen.max_concurrency`（默认 64）, THE Adapter SHALL 对新请求构造 `error.type=adapter_overloaded` 的 OpenAI 风格错误对象，并返回 HTTP 503；IF HTTP 响应写入客户端失败, THEN THE Adapter SHALL 仍在本地日志中记录一条 `error.type=adapter_overloaded` 的过载事件，确保过载状态被可观测地标注。
3. THE Adapter SHALL 为每个上游连接启用 Keep-Alive 连接池，连接复用上限由 Provider_Profile 的 `max_connections`（默认 16）控制。
4. WHEN 收到 SIGINT 或 SIGTERM, THE Adapter SHALL 停止接受新请求，并在最多 10 秒内等待在途请求完成后退出。

### Requirement 12: 与 cc switch 的协作

**User Story:** 作为 cc switch 的用户，我希望将 Adapter 作为 cc switch 的一个后端条目注册并切换，以便在多后端之间无缝切换。

#### Acceptance Criteria

1. THE Adapter SHALL 对外表现为一个兼容 OpenAI Responses API 的 Base URL（形如 `http://127.0.0.1:8787/v1`），可以被 cc_switch 作为单个后端条目登记。
2. THE Adapter SHALL 接受 cc_switch 透传的 `Authorization` 头作为 Admin_Key（Requirement 7），不对 cc_switch 的本地切换逻辑提出额外要求。
3. THE Adapter SHALL 提供一份示例 cc_switch 配置片段，位于项目仓库的 `docs/cc-switch.md` 路径，展示如何将 Adapter 注册为一个 Codex 后端。

### Requirement 13: 打包与部署形态

**User Story:** 作为用户，我希望能够以最低的环境门槛本地运行 Adapter，以便快速试用。

#### Acceptance Criteria

1. THE Adapter SHALL 以 Node.js（Node 20+）实现，并通过 npm 包 `codex-responses-adapter` 分发；选型理由：与 Codex CLI 同生态、SSE 与 HTTP 实现成熟、面向 JSON 协议调试便利。
2. THE Adapter SHALL 提供一个可执行入口 `codex-responses-adapter`, 支持子命令 `start`、`config print`、`config check`、`validate`。
3. THE Adapter SHALL 提供一个可选的 Docker 镜像构建脚本 `Dockerfile`, 构建出的镜像可通过 `-v` 挂载 Config_File 运行。
4. THE Adapter SHALL 在 README 中提供 Windows、macOS、Linux 三平台的最小化启动示例，覆盖：安装、生成示例 Config_File、启动、将 Codex CLI 指向 Adapter 的命令。
