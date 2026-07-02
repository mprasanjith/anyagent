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
    "AnyAgent detects the coding agent your end users already have installed (Claude Code, Codex, Gemini CLI) and drives it from your tool. You collect no API keys and pay no inference bill.",
  title: "AnyAgent: use the coding agent your users already have",
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
          AnyAgent
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
            Your users already have a coding agent.
            <br />
            Use it.
          </h1>
          <p className="hm-lede">
            AnyAgent detects the coding agent installed and signed in on your
            end-user’s machine and drives it from your tool. Prompts run on
            their install, under their login and subscription.
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
        <h2>Detect the agent, then run your prompt</h2>
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
          The prompt runs on the user’s own install, under their login and
          subscription. You collect no API keys and pay no inference bill.
        </p>
        <p className="hm-body">
          The same code path works against whichever supported agent they have.{" "}
          <Link className="hm-link" href="/docs/how-it-works">
            How the unified surface works →
          </Link>
        </p>
      </div>
    </section>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>What you build with it</h2>
        <p className="hm-body">
          You ship the prompt and the guardrails; the user’s agent supplies the
          model and the auth. AnyAgent suits tools that run a defined task
          against the user’s own project.
        </p>
        <div className="hm-cases">
          <div className="hm-case">
            <h3>Setup wizards</h3>
            <p>
              Wire your SDK into the user’s codebase from your init command.
            </p>
          </div>
          <div className="hm-case">
            <h3>Migrations</h3>
            <p>Apply a framework upgrade across the user’s repo.</p>
          </div>
          <div className="hm-case">
            <h3>Generators</h3>
            <p>Produce changelogs, tests, or docs from the current source.</p>
          </div>
        </div>
      </div>
    </section>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>Safe by default</h2>
        <p className="hm-body">
          Your tool is driving someone else’s install, so every run sets an
          explicit permission ceiling. AnyAgent itself adds zero runtime
          dependencies to your tool.
        </p>
        <SafetyPresets />
        <p className="hm-foot-note">
          <Link className="hm-link" href="/docs/permissions">
            How permissions work →
          </Link>
        </p>
      </div>
    </section>

    <section className="hm-section">
      <div className="hm-shell" data-reveal>
        <h2>Whichever agent they have</h2>
        <p className="hm-body">
          Fourteen harnesses audited: two adapters shipped, twelve on the way.
          For anything else, an adapter is one file.
        </p>
        <ul className="hm-wall">
          {HARNESSES.map((h) => {
            const cell = (
              <>
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
              </>
            );
            return (
              <li key={h.name}>
                {h.status === "shipped" ? (
                  <Link
                    className="hm-wall-cell"
                    href={`/docs/adapters/${h.logo}`}
                  >
                    {cell}
                  </Link>
                ) : (
                  <span className="hm-wall-cell">{cell}</span>
                )}
              </li>
            );
          })}
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
        <p className="hm-footer-line">
          Add AnyAgent to your tool with one zero-dependency package.
        </p>
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
            AnyAgent
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
