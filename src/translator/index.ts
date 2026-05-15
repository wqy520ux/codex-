/**
 * Barrel export for the `translator` module.
 *
 * Downstream code (ingress handlers, property tests) should import from
 * this file rather than reaching into `request.ts` / `response.ts` /
 * `stream.ts` directly, so the internal layout can evolve without
 * breaking consumers.
 */

export { translateRequest, InvalidRequestError } from "./request.js";
export type { Logger, TranslateRequestOptions } from "./request.js";

export { translateResponse, UpstreamShapeError } from "./response.js";
export type { TranslateResponseContext } from "./response.js";

export { mapUpstreamError } from "./errorMapper.js";
export type {
  MapUpstreamErrorParams,
  MapUpstreamErrorResult,
} from "./errorMapper.js";

export {
  createInitialStreamingState,
  encodeSseEvent,
  serializeFailedEvent,
  stepStream,
} from "./stream.js";
export type {
  CreateInitialStreamingStateContext,
  MessageItemState,
  StepStreamInput,
  StepStreamResult,
  StreamingPhase,
  StreamingState,
  ToolCallAccumulator,
  UpstreamErrorSignal,
} from "./stream.js";
