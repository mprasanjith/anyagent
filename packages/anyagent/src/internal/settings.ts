import { AnyAgentError } from "../errors.js";
import type { RunOptions, SessionOptions } from "../types.js";

/** The options a session owns for its whole lifetime, applied to every turn. */
export const SESSION_SETTINGS = [
  "cwd",
  "effort",
  "env",
  "extraArgs",
  "mcp",
  "model",
] as const;

export const settingsOf = (opts: SessionOptions): RunOptions => {
  const settings: RunOptions = {};
  for (const key of SESSION_SETTINGS) {
    const value = opts[key];
    if (value !== undefined) {
      Object.assign(settings, { [key]: value });
    }
  }
  return settings;
};

// JS callers bypass the compile-time omission on `SessionRunOptionsFor`.
export const rejectTurnOptions = (opts: RunOptions): void => {
  if (opts.resume !== undefined || opts.forkSession !== undefined) {
    throw new AnyAgentError(
      "InvalidOptions",
      "resume and forkSession are owned by the session; use agent.session({ resume, fork })"
    );
  }
  const owned = SESSION_SETTINGS.filter((key) => opts[key] !== undefined);
  if (owned.length > 0) {
    const many = owned.length > 1;
    throw new AnyAgentError(
      "InvalidOptions",
      `${owned.join(", ")} ${many ? "are" : "is"} owned by the session; set ${many ? "them" : "it"} on agent.session()`
    );
  }
};

/**
 * A session's options seen as run options, so the thread's settings and its
 * continuity are validated against the agent's capabilities before it opens.
 */
export const sessionRunOptions = (opts: SessionOptions): RunOptions => {
  const runOpts = settingsOf(opts);
  if (opts.resume !== undefined) {
    runOpts.resume = opts.resume;
  }
  if (opts.fork === true) {
    runOpts.forkSession = true;
  }
  return runOpts;
};

/**
 * Split a run's options into the thread it opens and the one turn it takes:
 * the settings and continuity options shape the session, everything else
 * belongs to the turn.
 */
export const splitRunOptions = (
  opts: RunOptions
): { settings: SessionOptions; turn: RunOptions } => {
  const { forkSession, resume, ...rest } = opts;
  const settings: SessionOptions = settingsOf(rest);
  if (resume !== undefined) {
    settings.resume = resume;
  }
  if (forkSession !== undefined) {
    settings.fork = forkSession;
  }
  const turn: RunOptions = { ...rest };
  for (const key of SESSION_SETTINGS) {
    if (key in turn) {
      Reflect.deleteProperty(turn, key);
    }
  }
  return { settings, turn };
};
