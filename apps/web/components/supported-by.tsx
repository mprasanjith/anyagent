import type { Capabilities } from "anyagent-js/types";
import Link from "next/link";

import { ADAPTERS } from "@/components/capability-matrix";

// Adapter id → asset basename under /public/agents.
const LOGO: Record<string, string> = {
  antigravity: "antigravity",
  "claude-code": "claude-code",
  cline: "cline",
  codex: "codex",
  cursor: "cursor",
  "gemini-cli": "gemini",
  goose: "goose",
  "kilo-code": "kilo",
  opencode: "opencode",
  pi: "pi",
};

// The check-and-narrow expression for each capability, shown beside the strip
// so the reader never leaves the page to learn how to guard the feature.
const GUARDS: Record<string, string> = {
  attachments: 'agent.supports("attachments")',
  authStatus: "agent.capabilities.authStatus",
  cwd: "agent.capabilities.cwd",
  effort: 'agent.supports("effort")',
  mcp: 'agent.supports("mcp")',
  modelListing: "agent.capabilities.modelListing",
  modelSelection: "agent.capabilities.modelSelection",
  readOnly: 'agent.supports("readOnly")',
  session: 'agent.supports("resume")',
  sessionFork: 'agent.supports("forkSession")',
  streaming: "agent.capabilities.streaming",
  structuredOutput: "agent.capabilities.structuredOutput",
  systemPrompt: "agent.capabilities.systemPrompt",
};

/**
 * A "works with" strip for one capability, rendered from the adapters' own
 * declarations so it can never drift from the code. Shows each supporting
 * harness's logo and name, the tier where it is not native, the derived
 * guard expression, and a link to the full matrix.
 */
export const SupportedBy = ({
  capability,
  guard,
  tier,
}: {
  capability: keyof Capabilities;
  /** Override the derived guard expression (e.g. session.supports("steer")). */
  guard?: string;
  /** Only show agents at this tier (e.g. "native" for live sessions). */
  tier?: "native";
}) => {
  const rows = ADAPTERS.map((adapter) => ({
    id: adapter.meta.id,
    name: adapter.meta.name,
    value: adapter.capabilities[capability],
  })).filter((row) => (tier ? row.value === tier : Boolean(row.value)));
  const mixed = new Set(rows.map((row) => row.value)).size > 1;
  const guardCode = guard ?? GUARDS[capability];

  return (
    <div className="not-prose my-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-fd-card px-3 py-2 text-sm">
      <span className="text-fd-muted-foreground">Works with</span>
      {rows.map((row) => (
        <span className="inline-flex items-center gap-1.5" key={row.id}>
          <img
            alt=""
            className="size-4"
            height={16}
            src={`/agents/${LOGO[row.id] ?? row.id}.svg`}
            width={16}
          />
          <span>{row.name}</span>
          {mixed && row.value !== "native" && (
            <span className="text-fd-muted-foreground text-xs">
              {row.value}
            </span>
          )}
        </span>
      ))}
      <span className="ms-auto inline-flex items-center gap-3">
        {guardCode && (
          <code className="rounded bg-fd-muted px-1.5 py-0.5 text-xs">
            {guardCode}
          </code>
        )}
        <Link
          className="text-fd-muted-foreground text-xs"
          href="/docs/adapters"
        >
          full matrix
        </Link>
      </span>
    </div>
  );
};
