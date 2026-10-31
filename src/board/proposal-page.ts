// The proposal page the board opens: the Markdown file as a readable page in the board's look, ids linked to their
// records. Only the subset the writer produces: headings, lists, tables, bold, a <details> block, line breaks, rules.

const ID = /^(R\d{4}|C\d{3}(-CH\d+)?|SYN-(PUB|PRJ|PAT)-\d+)$/

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function inline(text: string): string {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/ -&gt; /g, " → ")
    .replace(/\[([A-Z0-9-]+)\]/g, (whole, id: string) => (ID.test(id) ? `<a class="id" href="/record/${id}" target="_blank">${id}</a>` : whole))
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())

export function renderMarkdown(md: string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const t = line.trim()
    if (!t) {
      i++
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^<details><summary>(.*)<\/summary>$/.exec(t))) {
      out.push(`<details><summary>${inline(m[1])}</summary>`)
      i++
    } else if (t === "</details>") {
      out.push("</details>")
      i++
    } else if (t === "---") {
      out.push("<hr>")
      i++
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(t))) {
      const level = m[1].length === 1 ? 1 : m[1].length === 2 ? 2 : 3
      out.push(`<h${level}>${inline(m[2])}</h${level}>`)
      i++
    } else if (t.startsWith("|") && /^\|?\s*-{3}/.test(lines[i + 1]?.trim() ?? "")) {
      const head = cells(t)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]))
      out.push(
        `<div class="table"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      )
    } else if (/^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) {
      const ordered = /^\d+\.\s/.test(t)
      const items: string[] = []
      while (i < lines.length && (ordered ? /^\d+\.\s/ : /^[-*]\s/).test(lines[i].trim())) items.push(lines[i++].trim().replace(/^([-*]|\d+\.)\s+/, ""))
      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`)
    } else {
      // A paragraph runs to a blank line or a block; a line ending in two spaces breaks the line, as in Markdown.
      const parts: string[] = []
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|\d+\.\s|\||---$|<\/?details)/.test(lines[i].trim())) {
        parts.push(inline(lines[i].trim()) + (lines[i].endsWith("  ") ? "<br>" : " "))
        i++
      }
      out.push(`<p>${parts.join("").trim()}</p>`)
    }
  }
  return out.join("\n")
}

export function proposalPage(pairId: string, md: string): string {
  const title = /^#\s+(.*)$/m.exec(md)?.[1] ?? pairId
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Prenup</title>
<link rel="icon" type="image/svg+xml" href="/media/prenup-mark.svg">
<script>try { if (localStorage.getItem("prenup-theme") === "dark") document.documentElement.dataset.theme = "dark" } catch {}</script>
<style>
  @font-face { font-family: "Inter"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(/media/inter-latin-wght-normal.woff2) format("woff2"); unicode-range: U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD; }
  @font-face { font-family: "Inter"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(/media/inter-latin-ext-wght-normal.woff2) format("woff2"); unicode-range: U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF; }
  @font-face { font-family: "Inter"; font-style: normal; font-display: swap; font-weight: 100 900; src: url(/media/inter-cyrillic-wght-normal.woff2) format("woff2"); unicode-range: U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116; }
  :root {
    --bg: #f5f5f7; --surface: #ffffff; --ink: #1d1d1f; --muted: #6e6e73; --faint: #86868b; --line: rgba(0, 0, 0, .08); --fill: #f2f2f5;
    --accent: #0071e3; --accent-soft: rgba(0, 113, 227, .09); --shadow: 0 1px 1px rgba(0, 0, 0, .02), 0 2px 10px rgba(0, 0, 0, .05);
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", system-ui, sans-serif;
    --display: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Helvetica Neue", system-ui, sans-serif;
    --mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace;
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --bg: #000000; --surface: #1c1c1e; --ink: #f5f5f7; --muted: #a1a1a6; --faint: #737378; --line: rgba(255, 255, 255, .09); --fill: #2c2c2e;
    --accent: #0a84ff; --accent-soft: rgba(10, 132, 255, .18); --shadow: 0 0 0 1px rgba(255, 255, 255, .05), 0 6px 20px rgba(0, 0, 0, .35);
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 var(--sans); letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; }
  .bar { position: sticky; top: 0; display: flex; align-items: center; gap: 12px; padding: 12px 24px; background: color-mix(in srgb, var(--bg) 72%, transparent);
    backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  .bar a { color: var(--accent); text-decoration: none; font-weight: 500; }
  .bar .pair { margin-left: auto; font: 500 12px/1 var(--mono); letter-spacing: 0; }
  article { max-width: 820px; margin: 28px auto 64px; padding: 36px 44px; background: var(--surface); border-radius: 20px; box-shadow: var(--shadow); }
  h1 { margin: 0 0 20px; font: 700 30px/1.15 var(--display); letter-spacing: -0.03em; }
  h2, h3 { margin: 32px 0 10px; font: 600 19px/1.25 var(--display); letter-spacing: -0.02em; }
  p { margin: 0 0 12px; }
  h1 + p { padding: 14px 18px; border-radius: 14px; background: var(--fill); font-size: 14px; line-height: 1.7; }
  ul, ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 4px 0; }
  li::marker { color: var(--faint); }
  strong { font-weight: 600; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a.id, code { font: 500 12.5px/1 var(--mono); letter-spacing: 0; white-space: nowrap; }
  .table { overflow-x: auto; margin: 4px 0 14px; border: 1px solid var(--line); border-radius: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; line-height: 1.5; }
  th, td { padding: 10px 14px; text-align: left; vertical-align: top; border-top: 1px solid var(--line); }
  th { border-top: 0; background: var(--fill); color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  td:first-child { font-weight: 600; min-width: 150px; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
  details { margin: 28px 0 0; padding: 14px 18px; border-radius: 14px; background: var(--fill); font-size: 13.5px; color: var(--muted); }
  details[open] summary { margin-bottom: 10px; }
  summary { cursor: pointer; color: var(--ink); font-weight: 600; }
  details ul { padding-left: 18px; }
  @media (max-width: 700px) { article { margin: 0; padding: 24px 18px; border-radius: 0; box-shadow: none; } .bar { padding: 10px 16px; } h1 { font-size: 24px; } }
  @media print { .bar { display: none; } body { background: #fff; } article { box-shadow: none; margin: 0; max-width: none; } details { display: block; } }
</style>
</head>
<body>
<div class="bar"><a href="/">← Board</a><span>Proposal drafted by the agents, every fact checked by the Critic</span><span class="pair">${esc(pairId)}</span></div>
<article>
${renderMarkdown(md)}
</article>
</body>
</html>
`
}
