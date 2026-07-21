import { claudeCode } from "../claude-code.js";
import { cline } from "../cline.js";
import { codex } from "../codex.js";
import { goose } from "../goose.js";
import { kiloCode } from "../kilo-code.js";
import { opencode } from "../opencode.js";
import { pi } from "../pi.js";
import type { Adapter } from "../types.js";

// Built-in adapters. A new adapter appends its factory result here.
export const BUILTINS: Adapter[] = [
  claudeCode(),
  codex(),
  opencode(),
  kiloCode(),
  pi(),
  goose(),
  cline(),
];
