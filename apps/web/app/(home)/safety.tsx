"use client";

import { useCallback, useState } from "react";

import { cn } from "@/lib/cn";

const PRESETS = [
  {
    desc: "Full autonomy on the user's CLI: read, edit, run commands.",
    id: "default",
    label: "DEFAULT",
  },
  {
    desc: "Nothing on the machine changes. Agents that can't guarantee it refuse the run.",
    id: "read-only",
    label: "READ-ONLY",
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
      className={cn(
        "-ml-px cursor-pointer whitespace-nowrap border border-hm-rule bg-transparent px-4 py-3 font-hm-mono text-hm-label text-hm-muted uppercase tracking-hm-micro transition-colors duration-[120ms] ease-hm-out first:ml-0 hover:text-hm-ink",
        active && "relative z-10 border-hm-accent text-hm-ink"
      )}
      onClick={handleClick}
      type="button"
    >
      {label}
    </button>
  );
};

export const SafetyPresets = () => {
  const [active, setActive] = useState("default");
  const preset = PRESETS.find((p) => p.id === active) ?? PRESETS[0];

  return (
    <div className="mt-10">
      <fieldset
        aria-label="Safety preset"
        className="m-0 flex min-w-0 flex-wrap border-0 p-0"
      >
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
      <div
        aria-live="polite"
        className="hm-perm-panel min-h-13 pt-6"
        key={preset.id}
      >
        <p className="m-0 max-w-[62ch]">{preset.desc}</p>
      </div>
    </div>
  );
};
