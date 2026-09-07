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
<link rel="mask-icon" href="/brand/anchor.svg" color="#b4531f">
<meta name="description" content="Anchor — make your wallet a part of your desktop, not another browser tab.">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="brand" href="/">${MARK}<span>Anchor</span></a>
    <nav>
      <a href="/">Diary</a>
      <a href="/changelog.html">Changelog</a>
      <a href="https://github.com/ryanio/anchor">Source</a>
    </nav>
  </header>
  ${opts.subtitle ? `<p class="tagline">${opts.subtitle}</p>` : ""}
  <main>${body}</main>
  <footer>
    Built in the open on <a href="https://omarchy.org">Omarchy</a> ·
    <a href="https://github.com/ryanio/anchor">github.com/ryanio/anchor</a> · MIT
  </footer>
</div>
</body>
</html>`;
}

// ── build ──────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "diary"), { recursive: true });

// Static assets ship as-is.
for (const dir of ["brand"]) {
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
      `<li><a href="/diary/${e.slug}.html"><span class="entry-date">${esc(e.date)}</span><span class="entry-title">${esc(e.title)}</span><span class="entry-summary">${esc(e.summary)}</span></a></li>`,
  )
  .join("");

writeFileSync(
  join(OUT, "index.html"),
  page("Anchor — build diary", `<ul class="entries">${index}</ul>`, {
    subtitle:
      "Make your wallet a part of your desktop, not another browser tab. Built in the open — dead ends included.",
  }),
);

writeFileSync(
  join(OUT, "changelog.html"),
  page(
    "Changelog — Anchor",
    `<article>${markdown(readFileSync(join(ROOT, "..", "CHANGELOG.md"), "utf8"))}</article>`,
  ),
);

console.log(`built ${entries.length} entries -> ${OUT}`);
