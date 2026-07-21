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
      className="pointer-coarse:min-h-11 cursor-pointer border-0 bg-transparent px-2 py-1 font-hm-mono text-hm-label text-hm-muted uppercase tracking-hm-micro transition-colors duration-[120ms] ease-hm-out hover:text-hm-ink active:translate-y-px disabled:cursor-not-allowed disabled:opacity-55 data-[copied=true]:text-hm-accent"
      data-copied={copied}
      onClick={copy}
      type="button"
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
};
