import { safeHtmlCut } from '../../../src/modules/alerts/telegram-client.service';

const balanced = (html: string) => {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(b|i|u|s|code|pre|a)\b[^>]*>/gi)) {
    if (m[1]) { if (stack.pop() !== m[2].toLowerCase()) return false; } else stack.push(m[2].toLowerCase());
  }
  return stack.length === 0;
};

describe('safeHtmlCut (ES-434)', () => {
  it('short text is returned unchanged', () => {
    expect(safeHtmlCut('<b>hi</b>', 4000)).toBe('<b>hi</b>');
  });
  it('a cut inside a tag drops the half tag', () => {
    const out = safeHtmlCut('x'.repeat(95) + '<b>bold</b>' + 'y'.repeat(50), 100 + 30);
    expect(out).not.toMatch(/<[^>]*$/);
    expect(balanced(out)).toBe(true);
  });
  it('a cut inside an entity drops the half entity', () => {
    const out = safeHtmlCut('x'.repeat(95) + '&amp;&amp;&amp;&amp;', 100 + 30 - 3);
    expect(out).not.toMatch(/&[a-z#0-9]{0,8}$/i);
  });
  it('tags left open by the cut are closed in the right order', () => {
    const out = safeHtmlCut('<b><i>' + 'x'.repeat(5000) + '</i></b>', 4000);
    expect(balanced(out)).toBe(true);
    expect(out.endsWith('</i></b>')).toBe(true);
  });
  it('the exact case from the test: an HTML tag split by the 4000 limit', () => {
    const out = safeHtmlCut('<b>' + 'x'.repeat(3995) + '</b> tail', 4000);
    expect(balanced(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4000);
  });
  it('the result is never longer than the limit', () => {
    for (const n of [4001, 4500, 20000]) {
      expect(safeHtmlCut('<code>' + 'é'.repeat(n) + '</code>', 4000).length).toBeLessThanOrEqual(4000);
    }
  });
  it('text with no tags is simply cut', () => {
    const out = safeHtmlCut('a'.repeat(6000), 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.startsWith('aaaa')).toBe(true);
  });
});
