#!/usr/bin/env node
/**
 * Static site generator for anchor.ryanio.com — zero dependencies.
 *
 * Renders a deliberately small Markdown subset: headings, paragraphs, fenced code, lists,
 * blockquotes, tables, links, inline code, bold and italic. That is everything a build diary needs,
 * and it keeps the project's no-dependency promise. If you need more, write HTML in the entry.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { icon } from "./icons.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "dist");

// ── tiny markdown ──────────────────────────────────────────────────────────
// Escapes quotes too: without that, a link URL lands inside a quoted attribute and can close it.
const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Only http, https and mailto, plus site-relative paths. Everything else becomes an inert "#".
 * `javascript:` in a contributed diary entry would otherwise render as a live XSS link, and diary
 * entries arrive by pull request.
 */
function safeHref(url: string): string {
  const trimmed = url.trim();
  if (/^(?:\/|\.\/|#)/.test(trimmed)) return trimmed;
  if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
  return "#";
}

function inline(s: string): string {
  // Code spans are extracted BEFORE any other rule runs, so markdown inside `...` stays literal.
  // The sentinel is a private-use codepoint rather than NUL: same guarantee that it cannot occur in
  // real input, without a control character in a regex.
  // Doing it the other way round rendered `**not bold**` inside a code span as actual bold.
  const codes: string[] = [];
  const withPlaceholders = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return `\uE000CODE${codes.length - 1}\uE000`;
  });

  const html = esc(withPlaceholders)
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, text: string, href: string) =>
        // `href` is already escaped by the esc() above — escaping again turned &quot; into &amp;quot;
        // and mangled legitimate URLs. No raw quote can survive that pass, so the attribute is safe.
        `<a href="${safeHref(href)}">${text}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

  return html.replace(/\uE000CODE(\d+)\uE000/g, (_, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`);
}

/** Split a table row on unescaped pipes that are not inside a code span. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  // Drop the empty leading cell, and a trailing one only when the row ends with a pipe — otherwise
  // `| a | b` silently lost its last column.
  cells.shift();
  if (line.trimEnd().endsWith("|")) cells.pop();
  return cells.map((c) => c.trim());
}

const isSeparatorRow = (cells: string[]) =>
  cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, "")));

function markdown(src: string): string {
  const out: string[] = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const isBlockStart = (l: string) => /^(#{1,4}\s|```|>\s|\||\s*[-*]\s|\d+\.\s)/.test(l);

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) body.push(lines[i++]!.slice(2));
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    // Lists absorb wrapped continuation lines. Without this, every wrapped bullet in CHANGELOG.md
    // became its own <ul> followed by a stray <p> — which was live on the published changelog.
    const listMatch = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        if (/\d/.test(m[2]!) !== ordered) break;
        const parts = [m[3]!];
        i++;
        while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) {
          parts.push(lines[i++]!.trim());
        }
        items.push(`<li>${inline(parts.join(" "))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        const cells = splitRow(lines[i]!);
        if (!isSeparatorRow(cells)) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      // A table whose only rows were separators has no header; emit nothing rather than crash the
      // whole build on `head!.map`.
      if (head) {
        out.push(
          `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
            `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
        );
      }
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ── frontmatter ────────────────────────────────────────────────────────────
interface Entry {
  slug: string;
  title: string;
  date: string;
  summary: string;
  html: string;
}

function parseEntry(file: string): Entry {
  const raw = readFileSync(join(ROOT, "diary", file), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw.replace(/^\uFEFF/, ""));
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = Object.fromEntries(
    m[1]!
      .split("\n")
      .filter((l) => l.includes(":"))
      .map((l) => {
        const idx = l.indexOf(":");
        return [
          l.slice(0, idx).trim(),
          l
            .slice(idx + 1)
            .trim()
            .replace(/^["']|["']$/g, ""),
        ];
      }),
  );
  return {
    slug: file.replace(/\.md$/, ""),
    title: meta.title ?? file,
    date: meta.date ?? "",
    summary: meta.summary ?? "",
    html: markdown(m[2]!),
  };
}

// ── layout ─────────────────────────────────────────────────────────────────
// The token layer is shared with the rest of the project; the site stylesheet builds on it.
const TOKENS = readFileSync(join(ROOT, "..", "theme", "tokens.css"), "utf8");
const CSS = readFileSync(join(ROOT, "style.css"), "utf8");

/**
 * The mark is INLINED, not referenced with <img>. An SVG loaded through <img> is an isolated
 * document: `currentColor` resolves against its own root rather than the page, so it renders black
 * or as a broken icon. Inlining is what lets one file theme itself everywhere.
 */
const MARK = readFileSync(join(ROOT, "brand", "anchor.svg"), "utf8")
  .replace(/<\?xml[^>]*\?>/, "")
  .replace("<svg", '<svg class="mark" width="22" height="22" aria-hidden="true" focusable="false"')
  .trim();

function page(title: string, body: string, opts: { subtitle?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="mask-icon" href="/brand/anchor.svg" color="#0d6b80">
<meta name="theme-color" content="#06131a" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7fafb" media="(prefers-color-scheme: light)">
<meta name="description" content="Anchor — make your wallet a part of your desktop, not another browser tab.">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="An ambient OpenSea experience for Omarchy — a wallet-aware desktop, built in the open.">
<meta property="og:image" content="https://anchor.ryanio.com/assets/og.jpg">
<meta property="og:url" content="https://anchor.ryanio.com/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<style>${TOKENS}
${CSS}</style>
</head>
<body class="ambient">
<div class="hero-wash" aria-hidden="true"></div>
<div class="wrap">
  <header class="glass">
    <a class="brand" href="/">${MARK}<span>Anchor</span></a>
    <nav>
      <a href="/">${icon("book-open", 16)}<span>Diary</span></a>
      <a href="/changelog.html">${icon("scroll-text", 16)}<span>Changelog</span></a>
      <a href="https://ryanio.github.io/battle-for-the-ford/">${icon("gamepad-2", 16)}<span>Battle</span></a>
      <a href="https://github.com/ryanio/anchor">${icon("github", 15)}<span>Source</span></a>
    </nav>
  </header>
  ${opts.subtitle ? `<p class="tagline">${opts.subtitle}</p>` : ""}
  <main>${body}</main>
  <footer class="glass">
    Built in the open on <a href="https://omarchy.org">Omarchy</a> ·
    <a href="https://github.com/ryanio/anchor">github.com/ryanio/anchor ${icon("arrow-up-right", 13)}</a> · MIT
  </footer>
</div>
</body>
</html>`;
}

/**
 * Next-entry countdown. The diary runs on a nightly scheduler at 21:00; this counts down to it and
 * says so plainly when today's entry has landed. The job deliberately skips days that produced
 * nothing worth reading, so "no entry tonight" is an honest state, not a failure.
 */
const COUNTDOWN_JS = `<script>
(function () {
  var el = document.getElementById("countdown-text");
  var box = document.querySelector(".countdown");
  if (!el || !box) return;
  var latest = box.getAttribute("data-latest");

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  // Words, not a clock time: "13 hours, 24 minutes" reads as a countdown, "21:00" reads as a
  // schedule you have to do arithmetic on.
  function humanize(ms) {
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) return plural(h, "hour") + ", " + plural(m, "minute");
    if (m > 0) return plural(m, "minute") + ", " + plural(s, "second");
    return plural(s, "second");
  }

  function tick() {
    var now = new Date();
    var next = new Date(now);
    next.setHours(21, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    var left = humanize(next - now);
    var posted = latest === now.toISOString().slice(0, 10);
    el.innerHTML = posted
      ? "Today's entry is up. Next one in <b>" + left + "</b>."
      : "Next entry in <b>" + left + "</b> <span class='skip'>— skipped if nothing worth reading happened</span>";
  }

  tick();
  setInterval(tick, 1000);
})();
</script>`;

// ── build ──────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "diary"), { recursive: true });

// Static assets ship as-is.
for (const dir of ["brand", "assets"]) {
  if (existsSync(join(ROOT, dir))) cpSync(join(ROOT, dir), join(OUT, dir), { recursive: true });
}

const entries = readdirSync(join(ROOT, "diary"))
  .filter((f) => f.endsWith(".md"))
  .map(parseEntry)
  .sort((a, b) => b.date.localeCompare(a.date));

for (const e of entries) {
  writeFileSync(
    join(OUT, "diary", `${e.slug}.html`),
    page(
      `${e.title} — Anchor`,
      `<article><h1>${esc(e.title)}</h1><p class="date">${esc(e.date)}</p>${e.html}</article>`,
    ),
  );
}

const index = entries
  .map(
    (e) =>
      `<li><a class="glass" href="/diary/${e.slug}.html"><span class="entry-date">${esc(e.date)}</span><span class="entry-title">${esc(e.title)}</span><span class="entry-summary">${esc(e.summary)}</span></a></li>`,
  )
  .join("");

const latest = entries[0];
const hero = `<div class="hero">
  <h1>Make your wallet a part of your desktop, not another browser tab.</h1>
  <p class="tagline">An ambient OpenSea experience for Omarchy — a wallet-aware desktop, built in the open.</p>
</div>
<div class="countdown glass" data-latest="${latest?.date ?? ""}">
  ${icon("clock", 16)}<span id="countdown-text">Next entry: nightly at 21:00</span>
</div>`;

writeFileSync(
  join(OUT, "index.html"),
  page("Anchor — build diary", `${hero}<ul class="entries">${index}</ul>${COUNTDOWN_JS}`),
);

writeFileSync(
  join(OUT, "changelog.html"),
  page(
    "Changelog — Anchor",
    `<article>${markdown(readFileSync(join(ROOT, "..", "CHANGELOG.md"), "utf8"))}</article>`,
  ),
);

// llms.txt — a plain-text map of the site for language models (llmstxt.org).
const llms = [
  "# Anchor",
  "",
  "> An ambient OpenSea experience for Omarchy: a wallet-aware Linux desktop. Your art becomes the",
  "> theme, your watchlist lives in the bar, and an agent can act within spend controls it cannot",
  "> change. Built in the open at github.com/ryanio/anchor (MIT).",
  "",
  "## Build diary",
  "",
  ...entries.map((e) => `- [${e.title}](https://anchor.ryanio.com/diary/${e.slug}.html): ${e.summary}`),
  "",
  "## Project",
  "",
  "- [Changelog](https://anchor.ryanio.com/changelog.html): what shipped, and what broke.",
  "- [Source](https://github.com/ryanio/anchor): the repository.",
  "- [Working agreement](https://github.com/ryanio/anchor/blob/main/AGENTS.md): invariants, definition of done, what needs a human.",
  "- [Autonomy model](https://github.com/ryanio/anchor/blob/main/docs/autonomy.md): how an agent holds a real balance under spend controls enforced outside it.",
  "- [Security model](https://github.com/ryanio/anchor/blob/main/docs/security.md): keys, policy, and the withdrawal allowlist.",
  "",
  "## Related",
  "",
  "- [Battle for the Ford](https://ryanio.github.io/battle-for-the-ford/): a side project — a Roman battle in the browser, no dependencies.",
  "",
].join("\n");
writeFileSync(join(OUT, "llms.txt"), `${llms}\n`);

console.log(`built ${entries.length} entries -> ${OUT}`);
