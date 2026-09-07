#!/usr/bin/env node
/**
 * Static site generator for anchor.ryanio.com — zero dependencies.
 *
 * Renders a deliberately small Markdown subset: headings, paragraphs, fenced code, lists,
 * blockquotes, tables, links, inline code, bold and italic. That is everything a build diary needs,
 * and it keeps the project's no-dependency promise. If you need more, write HTML in the entry.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "dist");

// ── tiny markdown ──────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function markdown(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) { i++; continue; }

    if (line.startsWith("```")) {                       // fenced code
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

    if (line.startsWith("> ")) {                         // blockquote
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) body.push(lines[i++]!.slice(2));
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {                      // unordered list
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(`<li>${inline(lines[i++]!.replace(/^\s*[-*]\s+/, ""))}</li>`);
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {                        // ordered list
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(`<li>${inline(lines[i++]!.replace(/^\d+\.\s+/, ""))}</li>`);
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (line.startsWith("|")) {                          // table
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) {
        const cells = lines[i]!.split("|").slice(1, -1).map((c) => c.trim());
        if (!/^-+$/.test(cells[0]?.replace(/[\s:]/g, "") ?? "x")) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      out.push(
        `<table><thead><tr>${head!.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }

    const para: string[] = [];                           // paragraph
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>\s|\||\s*[-*]\s|\d+\.\s)/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ── frontmatter ────────────────────────────────────────────────────────────
interface Entry { slug: string; title: string; date: string; summary: string; html: string }

function parseEntry(file: string): Entry {
  const raw = readFileSync(join(ROOT, "diary", file), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const meta = Object.fromEntries(
    m[1]!.split("\n").map((l) => {
      const idx = l.indexOf(":");
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, "")];
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

function page(title: string, body: string, opts: { subtitle?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Anchor — make your wallet a part of your desktop, not another browser tab.">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <a class="brand" href="/">⚓ Anchor</a>
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

const entries = readdirSync(join(ROOT, "diary"))
  .filter((f) => f.endsWith(".md"))
  .map(parseEntry)
  .sort((a, b) => b.date.localeCompare(a.date));

for (const e of entries) {
  writeFileSync(
    join(OUT, "diary", `${e.slug}.html`),
    page(`${e.title} — Anchor`, `<article><h1>${esc(e.title)}</h1><p class="date">${esc(e.date)}</p>${e.html}</article>`),
  );
}

const index = entries
  .map((e) => `<li><a href="/diary/${e.slug}.html"><span class="entry-date">${esc(e.date)}</span><span class="entry-title">${esc(e.title)}</span><span class="entry-summary">${esc(e.summary)}</span></a></li>`)
  .join("");

writeFileSync(
  join(OUT, "index.html"),
  page("Anchor — build diary", `<ul class="entries">${index}</ul>`, {
    subtitle: "Make your wallet a part of your desktop, not another browser tab. Built in the open — dead ends included.",
  }),
);

writeFileSync(
  join(OUT, "changelog.html"),
  page("Changelog — Anchor", `<article>${markdown(readFileSync(join(ROOT, "..", "CHANGELOG.md"), "utf8"))}</article>`),
);

console.log(`built ${entries.length} entries -> ${OUT}`);
