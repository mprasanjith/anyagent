import { antigravity } from "anyagent-js/antigravity";
import { claudeCode } from "anyagent-js/claude-code";
import { cline } from "anyagent-js/cline";
import { codex } from "anyagent-js/codex";
import { cursor } from "anyagent-js/cursor";
import { geminiCli } from "anyagent-js/gemini-cli";
import { goose } from "anyagent-js/goose";
import { kiloCode } from "anyagent-js/kilo-code";
import { opencode } from "anyagent-js/opencode";
import { pi } from "anyagent-js/pi";
import type {
  Adapter,
  CapabilitySupport,
  DiscoverySupport,
  UsageSupport,
} from "anyagent-js/types";
import Link from "next/link";

// Registry order — the order detect() scans and returns.
export const ADAPTERS: Adapter[] = [
  claudeCode(),
  codex(),
  opencode(),
  kiloCode(),
  pi(),
  goose(),
  cline(),
  geminiCli(),
  antigravity(),
  cursor(),
];

const COLUMNS = [
  { key: "streaming", label: "Streaming" },
  { key: "modelSelection", label: "Model" },
  { key: "readOnly", label: "Read-only" },
  { key: "effort", label: "Effort" },
  { key: "authStatus", label: "Auth status" },
  { key: "modelListing", label: "Models" },
  { key: "usageStatus", label: "Usage" },
  { key: "resume", label: "Resume" },
  { key: "sessionFork", label: "Fork" },
  { key: "mcp", label: "MCP" },
  { key: "attachments", label: "Attachments" },
  { key: "systemPrompt", label: "System prompt" },
  { key: "structuredOutput", label: "Structured output" },
  { key: "cwd", label: "cwd" },
] as const;

const cell = (
  value: CapabilitySupport | DiscoverySupport | UsageSupport
): string => {
  if (value === false) {
    return "—";
  }
  return value;
};

/**
 * The adapters × capabilities support table on the supported-agents page,
 * rendered from each adapter's own capability declaration so it cannot
 * drift from the source.
 */
export const CapabilityMatrix = () => (
  <table>
    <thead>
      <tr>
        <th>Agent</th>
        <th>Binary</th>
        <th>Mode</th>
        {COLUMNS.map((c) => (
          <th key={c.key}>{c.label}</th>
        ))}
      </tr>
    </thead>
    <tbody>
      {ADAPTERS.map((adapter) => (
        <tr key={adapter.meta.id}>
          <td>
            <Link href={`/docs/adapters/${adapter.meta.id}`}>
              {adapter.meta.name}
            </Link>
          </td>
          <td>
            <code>{adapter.meta.bin[0]}</code>
          </td>
          <td>{adapter.mode}</td>
          {COLUMNS.map((c) => (
            <td key={c.key}>{cell(adapter.capabilities[c.key])}</td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);
