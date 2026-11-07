import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KnowledgeService } from '../../../src/modules/ai-chat/knowledge.service';
import { AiChatService } from '../../../src/modules/ai-chat/ai-chat.service';

const cfg = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] }) as any;
const gemini = (text: string) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

const make = (files: Record<string, string>, docs: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const k = path.join(root, 'knowledge');
  const d = path.join(root, 'docs');
  fs.mkdirSync(k);
  fs.mkdirSync(d);
  for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(k, n), t);
  for (const [n, t] of Object.entries(docs)) {
    fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
    fs.writeFileSync(path.join(d, n), t);
  }
  const svc = new KnowledgeService(cfg({ KNOWLEDGE_DIR: k, KNOWLEDGE_DOCS_DIR: d }));
  svc.reload();
  return svc;
};

const LOAN = '# Loan Guide\n\n## Early closure\n\nTo close a loan early open Administration > Loan > Early Closure. The member must pay the outstanding principal and the penalty up to the closing date. A lien on the RD account is released after closure.\n\n## Surety change\n\nChange Loan Surety replaces a guarantor on a running loan after the new surety is checked.\n';
const RD = '# RD Guide\n\n## Opening an RD account\n\nUse Masters > RD Account > Opening. Choose the member, monthly instalment and the tenure in months.\n';

describe('KnowledgeService', () => {
  it('splits files by heading and finds the right passage', () => {
    const k = make({ 'loan.md': LOAN, 'rd.md': RD });
    const hits = k.search('how do I close a loan early');
    expect(hits[0].heading).toBe('Early closure');
    expect(hits[0].title).toBe('Loan Guide');
    expect(k.search('open a new rd account')[0].source).toBe('rd.md');
  });

  it('matches plural and -ing forms', () => {
    const k = make({ 'loan.md': LOAN });
    expect(k.search('closing a loan early')[0].heading).toBe('Early closure');
  });

  it('returns nothing when the question is not covered, so the bot must say "not sure"', () => {
    const k = make({ 'loan.md': LOAN });
    expect(k.search('what is the weather in Delhi')).toEqual([]);
    expect(k.search('')).toEqual([]);
  });

  it('ranks curated staff files above engineering documentation on the same topic', () => {
    const k = make({ 'loan.md': LOAN }, { 'x/eng.md': '# Eng Report\n\n## Early closure\n\nEarly closure of a loan was refactored: the penalty is computed in the service layer up to the closing date.\n' });
    expect(k.search('early closure of a loan penalty')[0].source).toBe('loan.md');
  });

  it('skips engineering folders and test/audit/changelog files in the docs folder', () => {
    // filler documents so the word statistics resemble a real corpus, not a one-passage index
    const filler = Object.fromEntries(
      ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma'].map((n) => [`f/${n}.md`, `# ${n} doc\n\n## ${n} topic\n\nThis ${n} passage talks about something else entirely, long enough to be indexed here.\n`]),
    );
    const k = make({}, {
      ...filler,
      'qa/plan.md': '# QA\n\n## Zebra feature\n\nThe zebra feature text is long enough to be indexed here.\n',
      'loan/CHANGELOG.md': '# Log\n\n## Zebra change\n\nThe zebra change text is long enough to be indexed here.\n',
      'loan/loan-doc.md': '# Loan Doc\n\n## Giraffe feature\n\nThe giraffe feature text is long enough to be indexed here.\n',
    });
    expect(k.search('zebra')).toEqual([]);
    expect(k.search('giraffe')[0].source).toBe('loan-doc.md');
  });

  it('works with no folders at all', () => {
    const k = new KnowledgeService(cfg({ KNOWLEDGE_DIR: '/nope', KNOWLEDGE_DOCS_DIR: '/nope' }));
    expect(k.reload()).toEqual({ files: 0, chunks: 0 });
    expect(k.search('loan')).toEqual([]);
  });
});

describe('AiChatService with the knowledge base', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });
  const body = () => JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);

  it('puts the matching passages in the prompt and returns the sources', async () => {
    global.fetch = jest.fn(async () => gemini('ok')) as any;
    const k = make({ 'loan.md': LOAN });
    const r = await new AiChatService(cfg({ GEMINI_API_KEYS: 'k' }), undefined, k).chat([{ role: 'user', content: 'how to close a loan early?' }]);
    const sys = body().systemInstruction.parts[0].text;
    expect(sys).toContain('Documentation excerpts');
    expect(sys).toContain('Administration > Loan > Early Closure');
    expect(r.sources).toEqual([{ title: 'Loan Guide', heading: 'Early closure', file: 'loan.md' }]);
  });

  it('when nothing matches the prompt forbids guessing and there are no sources', async () => {
    global.fetch = jest.fn(async () => gemini('ok')) as any;
    const k = make({ 'loan.md': LOAN });
    const r = await new AiChatService(cfg({ GEMINI_API_KEYS: 'k' }), undefined, k).chat([{ role: 'user', content: 'tell me about cricket scores' }]);
    expect(body().systemInstruction.parts[0].text).toContain('No documentation passage matched');
    expect(r.sources).toEqual([]);
  });

  it('a short follow-up still finds the topic from the previous question', async () => {
    global.fetch = jest.fn(async () => gemini('ok')) as any;
    const k = make({ 'loan.md': LOAN });
    await new AiChatService(cfg({ GEMINI_API_KEYS: 'k' }), undefined, k).chat([
      { role: 'user', content: 'how to close a loan early?' },
      { role: 'assistant', content: 'Open Early Closure.' },
      { role: 'user', content: 'and the penalty?' },
    ]);
    expect(body().systemInstruction.parts[0].text).toContain('Documentation excerpts');
  });

  it('the real documentation answers common staff questions', () => {
    const real = new KnowledgeService(cfg({}));
    // runs from backend/, so ../docs/final-documentation and ./knowledge are found by themselves
    const r = real.reload();
    if (r.chunks === 0) return; // installed server without docs: nothing to check
    expect(real.search('how do I print the Day Book')[0]).toBeDefined();
    expect(real.search('where is Member Master in the menu')[0]).toBeDefined();
    expect(real.search('early closure of a loan')[0]).toBeDefined();
  });
});
