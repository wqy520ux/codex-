/**
 * Barrel export for the `utils` module. Downstream code imports from
 * this file so implementation layout (e.g. `mask.ts`) can evolve
 * without touching consumers.
 */

export { maskPii, maskSecret } from "./mask.js";
