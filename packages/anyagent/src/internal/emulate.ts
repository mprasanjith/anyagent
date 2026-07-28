import type { Adapter, RunOptions } from "../types.js";

const withSystemPrompt = (prompt: string, systemPrompt: string): string =>
  `<system-instructions>\n${systemPrompt}\n</system-instructions>\n\n${prompt}`;

// Also ACP mode's only channel for a schema: an ACP turn carries text and
// nothing else, so there is no flag to hand the schema to.
export const promptWithSchema = (
  prompt: string,
  schema: Record<string, unknown>
): string =>
  `${prompt}\n\nRespond with a single JSON value that matches this JSON Schema. Output only the JSON, with no prose and no code fences.\n\n<json-schema>\n${JSON.stringify(schema, null, 2)}\n</json-schema>`;

// Fold every option the adapter declares as `"emulated"` into the prompt and
// strip it from the options handed to `buildInvocation`, so the adapter never
// sees an option it has no flag for. Pure: returns a fresh prompt and opts.
//
// Two capabilities are emulated. `systemPrompt` wraps the prompt in a
// `<system-instructions>` preamble; `structuredOutput` (triggered by
// `opts.schema`) appends a JSON Schema appendix. When both apply the preamble
// comes first and the schema appendix last, so the schema instruction stays
// the closest thing to the model's own output.
export const applyEmulations = (
  adapter: Adapter,
  prompt: string,
  opts: RunOptions
): { prompt: string; opts: RunOptions } => {
  const caps = adapter.capabilities;
  let nextPrompt = prompt;
  const nextOpts = { ...opts };

  if (caps.systemPrompt === "emulated" && nextOpts.systemPrompt !== undefined) {
    nextPrompt = withSystemPrompt(nextPrompt, nextOpts.systemPrompt);
    nextOpts.systemPrompt = undefined;
  }

  if (caps.structuredOutput === "emulated" && nextOpts.schema !== undefined) {
    nextPrompt = promptWithSchema(nextPrompt, nextOpts.schema);
    nextOpts.schema = undefined;
  }

  return { opts: nextOpts, prompt: nextPrompt };
};
