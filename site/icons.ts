/**
 * Icons, inlined.
 *
 * All Lucide (ISC licence), all 1.75px strokes so they read as one family.
 *
 * `github` comes from Lucide 0.376.0, before brand icons were removed — it is the stroke octocat
 * with no enclosing circle. The filled Simple Icons mark was tried first and read as a heavy dark
 * blob beside 1.75px strokes, which no amount of resizing fixed: the problem was the fill, not the
 * size.
 *
 * Inlined rather than referenced with <img> because `currentColor` in an <img>-loaded SVG resolves
 * against that document's own root, not the page, so the icon renders black or broken.
 */

/** Lucide: 24x24, stroke, no fill. */
const STROKE: Record<string, string> = {
  github: `<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /> <path d="M9 18c-4.51 2-5-2-7-2" />`,
  "book-open": `<path d="M12 5v16" /> <path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />`,
  "scroll-text": `<path d="M15 12h-5" /> <path d="M15 8h-5" /> <path d="M19 17V5a2 2 0 0 0-2-2H4" /> <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />`,
  "arrow-up-right": `<path d="M7 7h10v10" /> <path d="M7 17 17 7" />`,
  clock: `<circle cx="12" cy="12" r="10" /> <path d="M12 6v6l4 2" />`,
  compass: `<circle cx="12" cy="12" r="10" /> <path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" />`,
  "gamepad-2": `<line x1="6" x2="10" y1="11" y2="11" /> <line x1="8" x2="8" y1="9" y2="13" /> <line x1="15" x2="15.01" y1="12" y2="12" /> <line x1="18" x2="18.01" y1="10" y2="10" /> <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" />`,
};

export function icon(name: string, size = 18): string {
  const stroke = STROKE[name];
  if (stroke) {
    return (
      `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ` +
      `aria-hidden="true" focusable="false">${stroke}</svg>`
    );
  }
  throw new Error(`unknown icon: ${name}`);
}
