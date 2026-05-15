/**
 * Barrel export for the `router` module.
 *
 * Downstream code (Ingress handlers, translators) should import from
 * this file rather than reaching into `resolver.ts` / `errors.ts`
 * directly; this keeps the internal layout free to evolve without
 * touching consumers.
 */

export { resolveModel } from "./resolver.js";
export type { ResolvedModel } from "./resolver.js";
export { ModelNotFoundError } from "./errors.js";
