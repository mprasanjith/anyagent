import type { Metadata } from "next";
import { JetBrains_Mono, Manrope, Teachers } from "next/font/google";
import Link from "next/link";

import "./landing.css";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { CopyButton } from "./copy-button";
import { HeroCanvas } from "./hero-canvas";
import { Reveal } from "./reveal";
import { SafetyPresets } from "./safety";

const display = Teachers({
  subsets: ["latin"],
  variable: "--font-teachers",
});
const body = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  description:
    "AnyAgent detects the coding agent your end users already have installed (Claude Code, Codex, opencode, Pi, Goose, and more) and drives it from your tool. You collect no API keys and pay no inference bill.",
  title: "AnyAgent: use the coding agent your users already have",
};

const GITHUB = "https://github.com/mprasanjith/anyagent";

/** From docs/specs/harness-audit.md — statuses are honest: "shipped" means
 * the adapter exists, "soon" means the headless surface is audited and the
 * adapter is on the way. `logo` is a file in public/agents/; `slug` overrides
 * the adapter-page path when it differs from the logo name. */
const HARNESSES: {
  logo: string;
  name: string;
  slug?: string;
  status: string;
}[] = [
  { logo: "claude-code", name: "Claude Code", status: "shipped" },
  { logo: "codex", name: "Codex", status: "shipped" },
  { logo: "opencode", name: "opencode", status: "shipped" },
  { logo: "kilo", name: "Kilo Code", slug: "kilo-code", status: "shipped" },
  { logo: "pi", name: "Pi", status: "shipped" },
  { logo: "goose", name: "Goose", status: "shipped" },
  { logo: "cline", name: "Cline", status: "shipped" },
  { logo: "gemini", name: "Gemini CLI", slug: "gemini-cli", status: "shipped" },
  { logo: "antigravity", name: "Antigravity", status: "shipped" },
  { logo: "cursor", name: "Cursor", status: "shipped" },
  { logo: "copilot", name: "GitHub Copilot", status: "soon" },
  { logo: "droid", name: "Factory droid", status: "soon" },
  { logo: "kiro-cli", name: "Kiro", status: "soon" },
  { logo: "devin", name: "Devin", status: "soon" },
  { logo: "amp", name: "Amp", status: "soon" },
];

const iVar = (i: number) => ({ "--i": i }) as React.CSSProperties;

const Shell = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div className={cn("mx-auto w-full max-w-6xl px-(--page-gutter)", className)}>
    {children}
  </div>
);

const Section = ({ children }: { children: React.ReactNode }) => (
  <section className="pt-26 pb-16 max-md:py-16">
    <Shell>
      <div data-reveal>{children}</div>
    </Shell>
  </section>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h2 className="m-0 min-w-0 max-w-[26ch] font-hm-display font-normal text-hm-2xl text-hm-ink leading-[1.1] tracking-[-0.02em] [overflow-wrap:anywhere]">
    {children}
  </h2>
);

const Body = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-6 max-w-[62ch] leading-[1.62] [&_code]:font-hm-mono [&_code]:text-[0.9em]">
    {children}
  </p>
);

const Label = ({ children }: { children: React.ReactNode }) => (
  <figcaption className="mb-4 font-hm-mono font-medium text-hm-ink text-hm-label uppercase tracking-hm-micro opacity-55">
    {children}
  </figcaption>
);

const navLink =
  "whitespace-nowrap text-hm-sm text-hm-muted no-underline transition-colors duration-[120ms] ease-hm-out hover:text-hm-ink hover:underline hover:underline-offset-[0.25em]";

const wordmark =
  "whitespace-nowrap font-hm-display text-hm-md tracking-[-0.01em] text-hm-ink no-underline";

const Kw = ({ children }: { children: React.ReactNode }) => (
  <span className="text-hm-muted">{children}</span>
);

const Str = ({ children }: { children: React.ReactNode }) => (
  <span className="text-hm-accent">{children}</span>
);

const Page = () => (
  <div
    className={cn(
      "home min-h-dvh bg-hm-paper font-hm-body font-normal text-hm-ink-2 [font-variant-numeric:tabular-nums]",
      display.variable,
      body.variable,
      mono.variable
    )}
  >
    <nav className="py-6">
      <Shell className="flex items-baseline justify-between">
        <Link className={wordmark} href="/">
          AnyAgent
        </Link>
        <div className="flex gap-6">
          <Link className={navLink} href="/docs">
            Docs
          </Link>
          <a className={navLink} href={GITHUB}>
            GitHub
          </a>
        </div>
      </Shell>
    </nav>

    <header className="hm-hero relative overflow-clip bg-hm-paper">
      <HeroCanvas />
      <Shell className="relative z-10 pt-26 pb-36 max-[60rem]:pt-16 max-[60rem]:pb-26">
        <div className="hm-reveal" style={iVar(0)}>
          <h1 className="m-0 min-w-0 max-w-[16ch] font-hm-display font-normal text-hm-display text-hm-ink leading-[1.04] tracking-[-0.01em] [overflow-wrap:anywhere]">
            Your users already have a coding agent.
            <br />
            Use it.
          </h1>
          <p className="mt-6 max-w-[52ch] text-hm-md leading-[1.6]">
            AnyAgent detects the coding agent installed and signed in on your
            end-user’s machine and drives it from your tool. Prompts run on
            their install, under their login and subscription.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-6">
            <Link
              className={buttonVariants({ variant: "primary" })}
              href="/docs"
            >
              Read the quickstart
            </Link>
            <a className={buttonVariants({ variant: "link" })} href={GITHUB}>
              View on GitHub →
            </a>
          </div>
        </div>
      </Shell>
    </header>

    <Section>
      <SectionTitle>Detect the agent, then run your prompt</SectionTitle>
      <figure className="m-0 mt-10 max-w-[46rem] border-hm-rule border-y pt-4 pb-6">
        <Label>INSTALLER.TS</Label>
        <pre className="m-0 overflow-x-auto font-hm-mono text-hm-sm leading-[1.75]">
          <Kw>{"import "}</Kw>
          {"{ create, detect } "}
          <Kw>from</Kw> <Str>"anyagent"</Str>
          {";\n\n"}
          <Kw>const</Kw>
          {" [agent] = "}
          <Kw>await</Kw>
          {" detect();\n"}
          <Kw>if</Kw>
          {" (!agent) "}
          <Kw>throw new</Kw>
          {" Error("}
          <Str>"no coding agent found"</Str>
          {");\n"}
          <Kw>const</Kw>
          {" result = "}
          <Kw>await</Kw>
          {" create(agent).run(\n  "}
          <Str>"wire our SDK into this project"</Str>
          {"\n);"}
        </pre>
      </figure>
      <Body>
        <code>detect()</code> returns whatever is installed. <code>run()</code>{" "}
        behaves the same on all of it. When no agent is installed,{" "}
        <code>detect()</code> returns an empty array and your tool can fall
        back.
      </Body>
      <Body>
        The prompt runs on the user’s own install, under their login and
        subscription. You collect no API keys and pay no inference bill.
      </Body>
      <Body>
        The same code path works against whichever supported agent they have.{" "}
        <Link
          className={buttonVariants({ variant: "link" })}
          href="/docs/how-it-works"
        >
          How the unified surface works →
        </Link>
      </Body>
    </Section>

    <Section>
      <SectionTitle>What you build with it</SectionTitle>
      <Body>
        You ship the prompt and the guardrails; the user’s agent supplies the
        model and the auth. AnyAgent suits tools that run a defined task against
        the user’s own project.
      </Body>
      <div className="mt-10 grid grid-cols-[0.9fr_0.95fr_1.15fr] gap-6 max-md:grid-cols-1">
        {[
          {
            desc: "Wire your SDK into the user’s codebase from your init command.",
            title: "Setup wizards",
          },
          {
            desc: "Apply a framework upgrade across the user’s repo.",
            title: "Migrations",
          },
          {
            desc: "Produce changelogs, tests, or docs from the current source.",
            title: "Generators",
          },
        ].map((c) => (
          <div
            className="hm-case relative overflow-clip rounded-xl border border-hm-rule p-6 transition-transform duration-[220ms] ease-hm-soft"
            key={c.title}
          >
            <h3 className="m-0 font-hm-display font-normal text-hm-ink text-hm-lg tracking-[-0.015em]">
              {c.title}
            </h3>
            <p className="mt-3 mb-0 text-hm-sm leading-[1.6]">{c.desc}</p>
          </div>
        ))}
      </div>
    </Section>

    <Section>
      <SectionTitle>Unattended by design</SectionTitle>
      <Body>
        Every run is unattended: the agent works at the full autonomy the user’s
        CLI allows, which is what lets a setup wizard finish without a human in
        the loop. When your tool only needs to look, <code>readOnly: true</code>{" "}
        confines the run to reading. An agent that cannot enforce that refuses
        the run instead of downgrading it silently.
      </Body>
      <SafetyPresets />
      <p className="mt-6 text-hm-muted text-hm-sm leading-[1.6]">
        <Link
          className={buttonVariants({ variant: "link" })}
          href="/docs/run-agents#keep-a-run-read-only"
        >
          How read-only runs work →
        </Link>
      </p>
    </Section>

    <Section>
      <SectionTitle>Whichever agent they have</SectionTitle>
      <Body>
        Fifteen harnesses audited: ten adapters shipped, five on the way. For
        anything else, an adapter is one file.
      </Body>
      <ul className="m-0 mt-10 grid list-none grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-px border border-hm-rule bg-hm-rule p-0">
        {HARNESSES.map((h) => {
          const cell = (
            <>
              <img
                alt=""
                className="block size-10 shrink-0 rounded-lg"
                height={40}
                loading="lazy"
                src={`/agents/${h.logo}.svg`}
                width={40}
              />
              <span className="grid min-w-0">
                <span className="text-hm-ink text-hm-sm">{h.name}</span>
                <span
                  className={cn(
                    "whitespace-nowrap font-hm-mono text-hm-label uppercase tracking-hm-micro",
                    h.status === "shipped" ? "text-hm-accent" : "text-hm-muted"
                  )}
                >
                  {h.status}
                </span>
              </span>
            </>
          );
          const cellClass = "flex h-full items-center gap-3 p-4 no-underline";
          return (
            <li className="bg-hm-paper" key={h.name}>
              {h.status === "shipped" ? (
                <Link
                  className={cn(
                    cellClass,
                    "text-inherit transition-colors duration-[120ms] ease-hm-out hover:bg-hm-paper-2"
                  )}
                  href={`/docs/adapters/${h.slug ?? h.logo}`}
                >
                  {cell}
                </Link>
              ) : (
                <span className={cellClass}>{cell}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-6 text-hm-muted text-hm-sm leading-[1.6]">
        <Link
          className={buttonVariants({ variant: "link" })}
          href="/docs/adding-an-adapter"
        >
          Adding an adapter →
        </Link>
      </p>
    </Section>

    <footer className="border-hm-rule border-t pt-26 pb-10">
      <Shell className="grid gap-10">
        <p className="m-0 min-w-0 max-w-[28ch] font-hm-display font-normal text-[clamp(1.75rem,5vw,3.25rem)] text-hm-ink leading-[1.05] tracking-[-0.02em] [overflow-wrap:anywhere]">
          Add AnyAgent to your tool with one zero-dependency package.
        </p>
        <div className="flex flex-wrap items-center gap-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-hm-rule bg-hm-paper-2 py-1 pr-1 pl-4">
            <code className="whitespace-nowrap font-hm-mono text-hm-sm">
              bun add anyagent
            </code>
            <CopyButton text="bun add anyagent" />
          </span>
          <Link className={buttonVariants({ variant: "primary" })} href="/docs">
            Read the quickstart
          </Link>
          <a className={buttonVariants({ variant: "link" })} href={GITHUB}>
            View on GitHub →
          </a>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-4 border-hm-rule border-t pt-4 text-hm-muted text-hm-sm">
          <Link className={cn(wordmark, "text-base")} href="/">
            AnyAgent
          </Link>
          <Link className={navLink} href="/docs">
            Docs
          </Link>
          <a className={navLink} href={GITHUB}>
            GitHub
          </a>
          <span>MIT</span>
        </div>
      </Shell>
    </footer>

    <Reveal />
  </div>
);

export default Page;
