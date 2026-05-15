/**
 * Curated preset list of OpenAI-compatible Chinese LLM providers,
 * surfaced through the `/admin/api/preset_providers` endpoint so the
 * admin UI can offer a one-click "Add provider" dropdown.
 *
 * Each entry pre-fills the fields a typical user knows about
 * (`base_url`, suggested `models`, capability flags). The `api_key`
 * is intentionally omitted — the user must paste their own.
 *
 * The list is data, not code: adding a new provider is a single
 * literal entry below. No dispatcher, no per-provider class hierarchy.
 */

export interface PresetProvider {
  /** Display name for the dropdown UI. */
  readonly label: string;
  /** Default `name` for the new ProviderProfile (also used as alias key). */
  readonly suggestedName: string;
  readonly base_url: string;
  /** Suggested model IDs (the user can edit). */
  readonly models: readonly string[];
  readonly capabilities: {
    readonly vision: boolean;
    readonly reasoning: boolean;
  };
  /** Optional reasoning parameter name (e.g. DeepSeek's `reasoning_effort`). */
  readonly reasoning_param_name?: string;
  /** One-line tip for the UI (shown next to the dropdown). */
  readonly tip?: string;
}

export const PRESET_PROVIDERS: readonly PresetProvider[] = [
  {
    label: "DeepSeek (深度求索)",
    suggestedName: "deepseek",
    base_url: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    capabilities: { vision: false, reasoning: true },
    reasoning_param_name: "reasoning_effort",
    tip: "deepseek-reasoner 支持推理强度 effort 参数",
  },
  {
    label: "Qwen / 通义千问 (阿里云 DashScope)",
    suggestedName: "qwen",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"],
    capabilities: { vision: false, reasoning: false },
    tip: "DashScope OpenAI-兼容模式",
  },
  {
    label: "智谱 GLM",
    suggestedName: "zhipu",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"],
    capabilities: { vision: false, reasoning: false },
    tip: "智谱 BigModel API",
  },
  {
    label: "Kimi (月之暗面 Moonshot)",
    suggestedName: "moonshot",
    base_url: "https://api.moonshot.cn/v1",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    capabilities: { vision: false, reasoning: false },
    tip: "数字代表上下文长度",
  },
  {
    label: "豆包 / Doubao (火山引擎)",
    suggestedName: "doubao",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    models: ["doubao-pro-32k", "doubao-pro-128k", "doubao-lite-32k"],
    capabilities: { vision: false, reasoning: false },
    tip: "上游 model 字段需填写 Endpoint ID 而非展示名",
  },
  {
    label: "MiniMax (海螺)",
    suggestedName: "minimax",
    base_url: "https://api.minimax.chat/v1",
    models: ["abab6.5s-chat", "abab6.5-chat"],
    capabilities: { vision: false, reasoning: false },
  },
  {
    label: "百川智能 (Baichuan)",
    suggestedName: "baichuan",
    base_url: "https://api.baichuan-ai.com/v1",
    models: ["Baichuan4", "Baichuan3-Turbo"],
    capabilities: { vision: false, reasoning: false },
  },
  {
    label: "SiliconFlow (硅基流动)",
    suggestedName: "siliconflow",
    base_url: "https://api.siliconflow.cn/v1",
    models: [
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V2.5",
      "01-ai/Yi-1.5-34B-Chat",
    ],
    capabilities: { vision: false, reasoning: false },
    tip: "聚合多家开源模型",
  },
  {
    label: "OpenRouter",
    suggestedName: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "google/gemini-pro-1.5",
    ],
    capabilities: { vision: false, reasoning: false },
    tip: "国际模型聚合",
  },
];
