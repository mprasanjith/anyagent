import type { Metadata } from "next";
import { JetBrains_Mono, Manrope, Teachers } from "next/font/google";
import Link from "next/link";

import "./landing.css";
import { CopyButton } from "./copy-button";
import { HeroCanvas } from "./hero-canvas";
import { Reveal } from "./reveal";
import { SafetyPresets } from "./safety";

const display = Teachers({
  subsets: ["latin"],
  variable: "--font-hm-display",
});
const body = Manrope({ subsets: ["latin"], variable: "--font-hm-body" });
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-hm-mono",
});

export const metadata: Metadata = {
  description:
    "A unified SDK for Claude Code, Codex, Gemini CLI, Cursor, and every other coding agent on your end-user's machine.",
  title: "anyagent — any coding agent, one SDK",
};

const GITHUB = "https://github.com/mprasanjith/anyagent";

/** From docs/specs/harness-audit.md — statuses are honest: "shipped" means
 * the adapter exists, "soon" means the headless surface is audited and the
 * adapter is on the way. `logo` is a file in public/agents/. */
const HARNESSES = [
  { logo: "claude-code", name: "Claude Code", status: "shipped" },
  { logo: "codex", name: "Codex", status: "shipped" },
  { logo: "gemini", name: "Gemini CLI", status: "soon" },
  { logo: "opencode", name: "opencode", status: "soon" },
  { logo: "pi", name: "Pi", status: "soon" },
  { logo: "cursor", name: "Cursor", status: "soon" },
  { logo: "copilot", name: "GitHub Copilot", status: "soon" },
  { logo: "cline", name: "Cline", status: "soon" },
  { logo: "droid", name: "Factory droid", status: "soon" },
  { logo: "goose", name: "Goose", status: "soon" },
  { logo: "kilo", name: "Kilo Code", status: "soon" },
  { logo: "kiro-cli", name: "Kiro", status: "soon" },
  { logo: "devin", name: "Devin", status: "soon" },
  { logo: "amp", name: "Amp", status: "soon" },
];

const iVar = (i: number) => ({ "--i": i }) as React.CSSProperties;

const Page = () => (
  <div className={`home ${display.variable} ${body.variable} ${mono.variable}`}>
    <nav className="hm-nav">
      <div className="hm-shell hm-nav-row">
        <Link className="hm-wordmark" href="/">
          anyagent
        </Link>
        <div className="hm-nav-links">
          <Link className="hm-nav-link" href="/docs">
            Docs
          </Link>
          <a className="hm-nav-link" href={GITHUB}>
            GitHub
          </a>
        </div>
      </div>
    </nav>

    <header className="hm-hero">
      <HeroCanvas />
      <div className="hm-shell hm-hero-inner">
        <div className="hm-reveal" style={iVar(0)}>
          <h1>
            Any coding agent.
            <br />
            One SDK.
          </h1>
          <p className="hm-lede">
            A unified SDK for Claude Code, Codex, Gemini CLI, Cursor, and every
            other coding agent on your end-user's machine.
          </p>
          <div className="hm-hero-actions">
            <Link className="hm-btn" href="/docs">
              Read the quickstart
            </Link>
            <a className="hm-link" href={GITHUB}>
              View on GitHub →
            </a>
          </div>
        </div>
      </div>
    </header>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>What you build with it</h2>
        <p className="hm-body">
          If your end-users are developers, a coding agent is probably already
          on their machine, installed and logged in. anyagent puts it to work
          from your tooling.
        </p>
        <div className="hm-cases">
          <div className="hm-case">
            <h3>Setup wizards</h3>
            <p>Wire your SDK into the user's existing codebase.</p>
          </div>
          <div className="hm-case">
            <h3>Migrations</h3>
            <p>Run migrations that read the code they're changing.</p>
          </div>
          <div className="hm-case">
            <h3>Tests, docs, commit messages</h3>
            <p>Bring AI models to your CLI or your scripts.</p>
          </div>
        </div>
      </div>
    </section>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>The exact same code. Any agent.</h2>
        <figure className="hm-codeframe">
          <figcaption className="hm-label">INSTALLER.TS</figcaption>
          <pre aria-label="Detect the installed agent and run a prompt">
            <span className="tok-kw">{"import "}</span>
            {"{ create, detect } "}
            <span className="tok-kw">from</span>{" "}
            <span className="tok-str">"anyagent"</span>
            {";\n\n"}
            <span className="tok-kw">const</span>
            {" [agent] = "}
            <span className="tok-kw">await</span>
            {" detect();\n"}
            <span className="tok-kw">const</span>
            {" result = "}
            <span className="tok-kw">await</span>
            {" create(agent).run(\n  "}
            <span className="tok-str">"wire our SDK into this project"</span>
            {",\n  { permission: "}
            <span className="tok-str">"edit"</span>
            {" },\n);"}
          </pre>
        </figure>
        <p className="hm-body">
          <code>detect()</code> returns whatever is installed.{" "}
          <code>run()</code> behaves the same on all of it. When no agent is
          installed, <code>detect()</code> returns an empty array and your tool
          can fall back.
        </p>
        <p className="hm-body">
          Prompts run through the user's own install, on their login and their
          subscription. No keys to collect, no bill to eat.
        </p>
        <p className="hm-body">
          <Link className="hm-link" href="/docs/concepts">
            How the unified surface works →
          </Link>
        </p>
      </div>
    </section>

    <div className="hm-stats" data-reveal>
      <div className="hm-shell hm-stats-grid">
        <div className="hm-stat">
          <b>14</b>
          <span className="hm-label">HARNESSES AUDITED</span>
        </div>
        <div className="hm-stat">
          <b>0</b>
          <span className="hm-label">RUNTIME DEPENDENCIES</span>
        </div>
        <div className="hm-stat">
          <b>3</b>
          <span className="hm-label">PERMISSION LEVELS</span>
        </div>
      </div>
    </div>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>Safe by default.</h2>
        <p className="hm-body">
          Three safety presets, mapped to each CLI's native flags. And anyagent
          itself adds zero runtime dependencies to your tool.
        </p>
        <SafetyPresets />
      </div>
    </section>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>Built to cover every harness.</h2>
        <p className="hm-body">
          Fourteen harnesses out of the box. For anything else, an adapter is
          one file.
        </p>
        <ul className="hm-wall">
          {HARNESSES.map((h) => (
            <li key={h.name}>
              <img
                alt=""
                height={40}
                loading="lazy"
                src={`/agents/${h.logo}.svg`}
                width={40}
              />
              <span className="hm-wall-info">
                <span className="hm-wall-name">{h.name}</span>
                <span className={`hm-status is-${h.status}`}>{h.status}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="hm-foot-note">
          <Link className="hm-link" href="/docs/adding-an-adapter">
            Adding an adapter →
          </Link>
        </p>
      </div>
    </section>

    <footer className="hm-footer">
      <div className="hm-shell hm-footer-inner">
        <p className="hm-footer-line">Ship the agent layer once.</p>
        <div className="hm-footer-actions">
          <span className="hm-install">
            <code>bun add anyagent</code>
            <CopyButton text="bun add anyagent" />
          </span>
          <Link className="hm-btn" href="/docs">
            Read the quickstart
          </Link>
          <a className="hm-link" href={GITHUB}>
            View on GitHub →
          </a>
        </div>
        <div className="hm-footer-meta">
          <Link className="hm-wordmark" href="/">
            anyagent
          </Link>
          <Link href="/docs">Docs</Link>
          <a href={GITHUB}>GitHub</a>
          <span>MIT</span>
        </div>
      </div>
    </footer>

    <Reveal />
  </div>
);

export default Page;
