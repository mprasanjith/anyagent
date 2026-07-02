"use client";

import { useState } from "react";

const PRESETS = [
  {
    desc: "Inspect the codebase. Nothing on disk changes.",
    id: "read",
    label: "READ",
  },
  {
    desc: "Change files inside the workspace.",
    id: "edit",
    label: "EDIT · DEFAULT",
  },
  {
    desc: "Edit and run commands without approval.",
    id: "auto",
    label: "AUTO",
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
      </div>
    </div>
  );
};
