import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

export interface KnowledgeChunk {
  source: string; // file name shown to the employee
  title: string; // document title (first # heading)
  heading: string; // nearest heading above the passage
  text: string;
  curated: boolean;
}

export interface KnowledgeHit extends KnowledgeChunk {
  score: number;
}

// Engineering / testing / planning folders of docs/final-documentation: not written for staff, so not indexed.
const EXCLUDED_DOC_DIRS = new Set([
  'qa', 'frontend_test_sweep', 'mobile_app_prd', 'ledger_acid_audit', '_doc_tools', 'rd_scenario_testing',
  'app_updates', 'report_pro_views_and_2fa_security', 'multi_language',
]);
const EXCLUDED_FILES = /changelog|test|audit|runbook|prd|build_list/i;

const MAX_CHUNK_CHARS = 1200;
const CURATED_BOOST = 1.2;
const MIN_SCORE_LARGE = 8; // real corpus (200+ passages): the 36 golden questions all clear 8, off-topic noise tops out near 7.9 (tune with the golden spec)
const MIN_SCORE_SMALL = 2.5; // tiny test corpora have low word statistics

const STOPWORDS = new Set(
  ('a an the is are was were be been to of in on at for from by with and or not no do does did how what which who whom why when where ' +
    'this that these those it its as if can could should would will shall may might me my we our you your i he she they them their ' +
    'kya hai hain ka ki ke ko se me mein par aur ya kaise kaun kab kahan kyun karna kare karo hota hoti hote').split(' '),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) || [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

// very light stemming so "loans"/"loan", "payments"/"payment", "closing"/"close" meet
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Staff knowledge base for the assistant (ES-438). Markdown files are split into passages by heading and
 * ranked with BM25 at question time. No external service: it works offline on a LAN server. Curated files in
 * backend/knowledge are written for staff and rank above the engineering documentation.
 */
@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeService.name);
  private chunks: KnowledgeChunk[] = [];
  private tokens: string[][] = [];
  private df = new Map<string, number>();
  private avgLen = 1;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.reload();
  }

  /** (Re)build the index. Run again after the documents change, e.g. on each release. */
  reload(): { files: number; chunks: number } {
    const chunks: KnowledgeChunk[] = [];
    let files = 0;
    for (const dir of this.curatedDirs()) files += this.loadDir(dir, true, chunks);
    for (const dir of this.docDirs()) files += this.loadDir(dir, false, chunks);
    this.index(chunks);
    this.logger.log(`Knowledge base: ${chunks.length} passages from ${files} files`);
    return { files, chunks: chunks.length };
  }

  /** Index ready-made chunks (used by tests). */
  index(chunks: KnowledgeChunk[]): void {
    this.chunks = chunks;
    this.tokens = chunks.map((c) => tokenize(`${c.title} ${c.heading} ${c.text}`));
    this.df = new Map();
    for (const toks of this.tokens) for (const t of new Set(toks)) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.avgLen = this.tokens.length ? this.tokens.reduce((n, t) => n + t.length, 0) / this.tokens.length : 1;
  }

  size(): number {
    return this.chunks.length;
  }

  search(query: string, limit = 4): KnowledgeHit[] {
    const q = tokenize(query);
    if (q.length === 0 || this.chunks.length === 0) return [];
    const N = this.chunks.length;
    const k1 = 1.4;
    const b = 0.75;
    const hits: KnowledgeHit[] = [];
    this.tokens.forEach((toks, i) => {
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const term of new Set(q)) {
        const f = tf.get(term);
        if (!f) continue;
        const n = this.df.get(term) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / this.avgLen)));
      }
      // a match in the heading or title is worth more than one buried in the text
      const head = tokenize(`${this.chunks[i].title} ${this.chunks[i].heading}`);
      for (const term of new Set(q)) if (head.includes(term)) score += 0.8;
      if (this.chunks[i].curated) score *= CURATED_BOOST;
      if (score >= (N >= 200 ? MIN_SCORE_LARGE : MIN_SCORE_SMALL)) hits.push({ ...this.chunks[i], score });
    });
    return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
  }

  private curatedDirs(): string[] {
    const fromEnv = this.config.get<string>('KNOWLEDGE_DIR');
    if (fromEnv) return this.existing([fromEnv]); // an explicit setting is used as given, never mixed with the defaults
    const candidates = [path.join(process.cwd(), 'knowledge'), path.join(__dirname, '..', '..', '..', 'knowledge'), path.join(__dirname, '..', '..', '..', '..', 'knowledge')];
    return this.existing(candidates);
  }

  private docDirs(): string[] {
    const fromEnv = this.config.get<string>('KNOWLEDGE_DOCS_DIR');
    if (fromEnv) return this.existing([fromEnv]);
    const candidates = [path.join(process.cwd(), '..', 'docs', 'final-documentation'), path.join(process.cwd(), 'docs', 'final-documentation')];
    return this.existing(candidates);
  }

  private existing(candidates: Array<string | undefined>): string[] {
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!c) continue;
      const abs = path.resolve(c);
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) seen.add(abs);
    }
    // the first hit wins; the same folder reached by two paths must not be indexed twice
    return [...seen].slice(0, 1);
  }

  private loadDir(dir: string, curated: boolean, out: KnowledgeChunk[]): number {
    let files = 0;
    const walk = (d: string, top: boolean) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (!curated && top && EXCLUDED_DOC_DIRS.has(entry.name)) continue;
          walk(full, false);
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          if (!curated && EXCLUDED_FILES.test(entry.name)) continue;
          try {
            this.chunkFile(fs.readFileSync(full, 'utf8'), entry.name, curated, out);
            files++;
          } catch (err) {
            this.logger.warn(`Knowledge file skipped (${entry.name}): ${err.message}`);
          }
        }
      }
    };
    walk(dir, true);
    return files;
  }

  chunkFile(markdown: string, source: string, curated: boolean, out: KnowledgeChunk[]): void {
    let title = source.replace(/\.md$/i, '');
    let heading = '';
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join('\n').trim();
      buf = [];
      if (text.length < 40) return;
      // long sections are cut at paragraph borders so no passage exceeds the prompt budget
      let cur = '';
      for (const para of text.split(/\n{2,}/)) {
        if (cur && cur.length + para.length > MAX_CHUNK_CHARS) {
          out.push({ source, title, heading, text: cur.trim(), curated });
          cur = '';
        }
        cur += (cur ? '\n\n' : '') + para.slice(0, MAX_CHUNK_CHARS * 2);
      }
      if (cur.trim().length >= 40) out.push({ source, title, heading, text: cur.trim(), curated });
    };
    for (const line of markdown.split(/\r?\n/)) {
      const m = /^(#{1,4})\s+(.*)$/.exec(line);
      if (m) {
        flush();
        if (m[1] === '#' && title === source.replace(/\.md$/i, '')) title = m[2].trim();
        heading = m[2].trim();
      } else {
        buf.push(line);
      }
    }
    flush();
  }
}
