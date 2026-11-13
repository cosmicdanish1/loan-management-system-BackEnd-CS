'use strict';
/**
 * Builds the mapping-diagram pages from the Mermaid blocks in migration-v1.md.
 * The markdown file is the single source of truth: edit the diagram there, then run
 *   node scripts/legacy-migration/build-diagrams.js
 * Outputs (both generated, do not edit by hand):
 *   migration-diagrams.html           local page, loads Mermaid from cdnjs (needs internet once)
 *   migration-diagrams.artifact.html  same content as a claude.ai Artifact page (Mermaid is built in there)
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'migration-v1.md');
const OUT_LOCAL = path.join(__dirname, 'migration-diagrams.html');
const OUT_ARTIFACT = path.join(__dirname, 'migration-diagrams.artifact.html');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const INIT = "%%{init: {'theme':'base','themeVariables':{'primaryTextColor':'#1d1f23','lineColor':'#4a5260','fontFamily':'Inter, system-ui, sans-serif','fontSize':'14px'}}}%%";

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const diagrams = [];
let title = null;
for (let i = 0; i < lines.length; i++) {
  const h = /^###\s+Diagram:\s*(.+)$/.exec(lines[i]);
  if (h) title = h[1].trim();
  if (lines[i].trim() === '```mermaid') {
    const body = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '```') body.push(lines[i++]);
    let log = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      if (lines[j].startsWith('**Decision log')) { log = lines[j].replace(/\*\*/g, ''); break; }
    }
    diagrams.push({ title: title || 'Diagram ' + (diagrams.length + 1), code: INIT + '\n' + body.join('\n'), log });
  }
}
if (!diagrams.length) throw new Error('No mermaid blocks found in ' + SRC);

const today = new Date().toISOString().slice(0, 10);
const legend = '<div class="legend"><span class="k">solid arrow: copied exactly</span><span class="k">dashed arrow: derived from other legacy data</span><span class="k">thick arrow: special rule</span><span class="k">grey dashed box: new in the app, stays empty</span><span class="k">red box: pre-check that can block the run</span></div>';
const nav = diagrams.map((d, i) => `<a href="#d${i}">${esc(d.title)}</a>`).join('');
const sections = diagrams.map((d, i) => `
<section id="d${i}">
  <h2>${esc(d.title)}</h2>
  ${legend}
  <div class="scroll"><pre class="mermaid">${esc(d.code)}</pre></div>
  ${d.log ? `<p class="log">${esc(d.log)}</p>` : ''}
</section>`).join('\n');

const css = `
:root{--bg:#f7f8fa;--fg:#1d1f23;--mut:#5b6573;--bd:#d6dbe2;--card:#ffffff;--accent:#2f6fd0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#13161b;--fg:#e6e9ee;--mut:#9aa4b2;--bd:#2b313a;--card:#ffffff;--accent:#7fb0ff;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#13161b;--fg:#e6e9ee;--mut:#9aa4b2;--bd:#2b313a;--card:#ffffff;--accent:#7fb0ff;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:15px/1.55 Inter,system-ui,Segoe UI,sans-serif;padding-block:20px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
h1{font:600 21px/1.25 "Space Grotesk",Inter,system-ui,sans-serif;margin:0 0 4px;text-wrap:balance}
h2{font:600 17px/1.3 "Space Grotesk",Inter,system-ui,sans-serif;margin:28px 0 8px;text-wrap:balance}
.sub{color:var(--mut);margin:0 0 12px;max-width:65ch}
nav{display:flex;flex-wrap:wrap;gap:6px 14px}nav a{color:var(--accent)}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px;font-size:13px;color:var(--mut)}
.k{border:1px solid var(--bd);border-radius:6px;padding:2px 8px}
.scroll{overflow-x:auto;border:1px solid var(--bd);border-radius:8px;padding:12px;background:var(--card);color:#1d1f23}
.log{color:var(--mut);font-size:14px;max-width:75ch}
`;
const head = `<title>Migration Column Maps</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Space+Grotesk:wght@600&display=swap">
<style>${css}</style>`;
const bodyHtml = `<h1>Legacy MS SQL to Postgres: column maps</h1>
<p class="sub">One map per table, updated with every decision. Generated ${today} from migration-v1.md.</p>
<nav>${nav}</nav>
${sections}`;

fs.writeFileSync(OUT_ARTIFACT, `${head}\n${bodyHtml}\n`);
fs.writeFileSync(OUT_LOCAL, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${bodyHtml}
<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js"></script>
<script>mermaid.initialize({startOnLoad:true,securityLevel:'loose',flowchart:{useMaxWidth:false,htmlLabels:true,curve:'basis'}});</script>
</body></html>`);
console.log(`Wrote 2 pages with ${diagrams.length} diagram(s): ${diagrams.map(d => d.title).join(' | ')}`);
