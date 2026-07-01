"use client";

import { useRef, useState } from "react";

/** Copy-to-clipboard with the label swap as the only feedback — no toast. */
export const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(false), 2500);
  };

  return (
    <button
      aria-label={`Copy "${text}" to the clipboard`}
      className="hm-copy"
      data-state={copied ? "copied" : undefined}
      onClick={copy}
      type="button"
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
};
