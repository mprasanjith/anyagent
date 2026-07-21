"use client";

import { useCallback, useState } from "react";

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

const PresetButton = ({
  active,
  id,
  label,
  onSelect,
}: {
  active: boolean;
  id: string;
  label: string;
  onSelect: (id: string) => void;
}) => {
  const handleClick = useCallback(() => onSelect(id), [onSelect, id]);
  return (
    <button
      aria-pressed={active}
      className={active ? "is-active" : undefined}
      onClick={handleClick}
      type="button"
    >
      {label}
    </button>
  );
};

export const SafetyPresets = () => {
  const [active, setActive] = useState("edit");
  const preset = PRESETS.find((p) => p.id === active) ?? PRESETS[1];

  return (
    <div className="hm-safety">
      <fieldset aria-label="Safety preset" className="hm-perm">
        {PRESETS.map((p) => (
          <PresetButton
            active={p.id === active}
            id={p.id}
            key={p.id}
            label={p.label}
            onSelect={setActive}
          />
        ))}
      </fieldset>
      <div aria-live="polite" className="hm-perm-panel" key={preset.id}>
        <p>{preset.desc}</p>
      </div>
    </div>
  );
};
