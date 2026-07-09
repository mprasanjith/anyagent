/**
 * The executable half of the adapter contract, published as its own subpath so
 * a third-party adapter author can verify a new adapter the same way the
 * built-ins are verified:
 *
 * ```ts
 * import { runConformance } from "anyagent/conformance";
 * ```
 *
 * {@link runConformance} replays recorded fixtures through the full agent
 * pipeline and asserts the invariants every adapter must uphold.
 * {@link sourceFromBody} and {@link fixedRunner} are the offline test doubles
 * it builds on, exported for adapters that need to drive the pipeline directly.
 */
export {
  type ConformanceOptions,
  runConformance,
} from "../internal/conformance/suite.js";
export {
  fixedRunner,
  sourceFromBody,
} from "../internal/conformance/scenarios.js";
