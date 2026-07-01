"use client";

import { useState } from "react";

/** Values mirror the adapters' real mapping tables:
 * packages/anyagent/src/claude-code/index.ts (PERMISSION_MODE) and
 * packages/anyagent/src/codex/index.ts (SANDBOX_MODE). */
const PRESETS = [
  {
    claude: "--permission-mode default",
    codex: "--sandbox read-only",
    desc: "Inspect the codebase. Nothing on disk changes.",
    id: "read-only",
    label: "READ-ONLY",
  },
  {
    claude: "--permission-mode acceptEdits",
    codex: "--sandbox workspace-write",
    desc: "Change files inside the workspace.",
    id: "edit",
    label: "EDIT · DEFAULT",
  },
  {
    claude: "--permission-mode bypassPermissions",
    codex: "--sandbox danger-full-access",
    desc: "Edit and run commands without approval.",
    id: "full-auto",
    label: "FULL-AUTO",
  },
];

export const SafetyPresets = () => {
  const [active, setActive] = useState("edit");
  const preset = PRESETS.find((p) => p.id === active) ?? PRESETS[1];

  return (
    <div className="hm-safety">
      <div aria-label="Safety preset" className="hm-perm" role="group">
        {PRESETS.map((p) => (
          <button
            aria-pressed={p.id === active}
            className={p.id === active ? "is-active" : undefined}
            key={p.id}
            onClick={() => setActive(p.id)}
            type="button"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div aria-live="polite" className="hm-perm-panel" key={preset.id}>
        <p>{preset.desc}</p>
        <pre>
          {`claude ${preset.claude}\n`}
          {`codex  ${preset.codex}`}
        </pre>
      </div>
    </div>
  );
};
