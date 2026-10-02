// The Markdown renderer of the docs pages (scripts/markdown.ts): GitHub's heading ids, no raw HTML, the link
// decisions, bare URLs next to Chinese text, tables, and Chinese line breaks.
import { describe, expect, it } from 'vitest';
import { Slugger, githubSlug, joinCjkLines, renderMarkdown, type LinkDecision } from '../scripts/markdown.ts';
import { parsePage } from './html.ts';

const keepAll = (href: string): LinkDecision => ({ href });
const render = (markdown: string, resolveLink: (href: string) => LinkDecision = keepAll) =>
  renderMarkdown(markdown, { resolveLink, tableLabel: (section) => (section === undefined ? 'Table' : `Table: ${section}`), reservedIds: ['main'] });

describe('heading ids', () => {
  it('are GitHub’s: lower case, punctuation dropped (full-width too), spaces to hyphens', () => {
    // Headings of the guides in both languages, and the anchors their tables of contents and the CLI's links use.
    for (const [heading, id] of [
      ['4. Before you share', '4-before-you-share'],
      ['5. Agent access and agents\' shell commands', '5-agent-access-and-agents-shell-commands'],
      ['9. Updating and removing', '9-updating-and-removing'],
      ['2.2 Other relays (`--relay`)', '22-other-relays---relay'],
      ['8. What "Host offline" means', '8-what-host-offline-means'],
      ['10. Joining from a terminal (CLI, optional)', '10-joining-from-a-terminal-cli-optional'],
      ['1. 用邀請連結加入', '1-用邀請連結加入'],
      ['2. 角色：可以做什麼', '2-角色可以做什麼'],
      ['5. 看 agent 工作、提出建議', '5-看-agent-工作提出建議'],
      ['6. 開自己的 agent session、登入 Claude', '6-開自己的-agent-session登入-claude'],
      ['8.「主人已離線」是什麼意思', '8主人已離線是什麼意思'],
      ['10. 用終端機（CLI）加入（選用）', '10-用終端機cli加入選用'],
      ['4. 分享前必讀（SPEC §11）', '4-分享前必讀spec-11'],
      ['[0.1.0] - 2026-10-01', '010---2026-10-01'],
      ['C++ & Rust: `a_b`!', 'c--rust-a_b'],
      ['Ünïcödé Straße', 'ünïcödé-straße'],
    ] as const) {
      expect(githubSlug(heading), heading).toBe(id);
    }
  });

  it('number repeated headings the way GitHub does', () => {
    const slugger = new Slugger();
    expect(['x', 'x', 'x-1', 'x'].map((text) => slugger.slug(text))).toEqual(['x', 'x-1', 'x-1-1', 'x-2']);
  });

  it('are given to every heading, from its text without markup, and a page-template id is refused', () => {
    const r = render('# Title\n\n## The `code` and [link](#title)\n\n## Main\n');
    expect(r.headings).toEqual([
      { depth: 1, id: 'title', text: 'Title' },
      { depth: 2, id: 'the-code-and-link', text: 'The code and link' },
      { depth: 2, id: 'main', text: 'Main' },
    ]);
    expect(r.html).toContain('<h2 id="the-code-and-link">The <code>code</code> and <a href="#title">link</a></h2>');
    expect(r.problems).toEqual(['heading "Main" would take the id "main", which the page template uses']);
  });
});

describe('raw HTML', () => {
  it('is never passed through: blocks, inline tags, comments and what follows a <code> tag are escaped text', () => {
    const r = render(
      [
        '<script>alert(1)</script>',
        '',
        '<div onclick="x()">block</div>',
        '',
        'inline <b>bold</b> & <img src=x onerror=alert(1)> <!-- comment -->',
        '',
        '<code>raw</code> <i>after</i> <a href="javascript:alert(1)">x</a>',
        '',
        '`<kept>` and the join link `https://app.smurg.ai/join/<id>#…`',
      ].join('\n'),
    );
    const page = parsePage(`<!doctype html><title>t</title>${r.html}`);
    expect(page.errors).toEqual([]);
    expect(page.byTag('body')[0]?.children().map((el) => el.tag)).toEqual(['p', 'p', 'p', 'p', 'p']);
    expect(page.elements.filter((el) => !['html', 'head', 'title', 'body', 'p', 'code'].includes(el.tag)).map((el) => el.tag)).toEqual([]);
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(r.html).toContain('<code>&lt;kept&gt;</code>');
    expect(r.html).not.toMatch(/<(script|div|b|i|img|a)\b/);
    // Reported with their lines, so the docs can be fixed.
    expect(r.rawHtml.map((line) => line.split(':')[0])).toEqual(['1', '1', '3', '3', '5', '5', '5', '5', '7', '7', '7', '7', '7', '7']);
  });

  it('refuses images (the CSP allows only this site’s files, and the docs have none)', () => {
    const r = render('![a picture](https://example.com/a.png)');
    expect(r.html).not.toContain('<img');
    expect(r.problems).toEqual(['line 1: an image (https://example.com/a.png); the site has no images from the docs']);
  });
});

describe('links', () => {
  it('go through the resolver: kept links get its href (escaped), the others become their own text', () => {
    const seen: string[] = [];
    const r = render('[a](JOINING.md#x) [`b`](../apps/relay/README.md) [c](https://example.com/?a=1&b="2")\n\nnext [a](JOINING.md#x)', (href) => {
      seen.push(href);
      if (href.startsWith('JOINING.md')) return { href: '/docs/joining/#x' };
      if (href.startsWith('https:')) return { href };
      return { plain: 'not published' };
    });
    expect(seen).toEqual(['JOINING.md#x', '../apps/relay/README.md', 'https://example.com/?a=1&b="2"', 'JOINING.md#x']);
    expect(r.html).toContain('<a href="/docs/joining/#x">a</a> <code>b</code> <a href="https://example.com/?a=1&amp;b=&quot;2&quot;">c</a>');
    expect(r.links.map((l) => [l.line, l.text])).toEqual([
      [1, 'a'],
      [1, 'b'],
      [1, 'c'],
      [3, 'a'],
    ]);
  });

  it('bare URLs end at the first character that is not ASCII, and before closing punctuation', () => {
    const r = render('公用 relay：https://app.smurg.ai（也是網頁版）。See https://smurg.ai/docs/, or (https://smurg.ai/x).');
    expect(r.links.map((l) => l.href)).toEqual(['https://app.smurg.ai', 'https://smurg.ai/docs/', 'https://smurg.ai/x']);
    expect(r.html).toContain('<a href="https://app.smurg.ai">https://app.smurg.ai</a>（也是網頁版）');
  });

  it('autolinks in angle brackets are links; www. and e-mail addresses stay text', () => {
    const r = render('<https://smurg.ai/docs/> www.example.com someone@example.com');
    expect(r.links.map((l) => l.href)).toEqual(['https://smurg.ai/docs/']);
    expect(r.html).toContain('www.example.com someone@example.com');
  });
});

describe('tables and text', () => {
  it('a table is a named, focusable scroll box, and its alignment a class', () => {
    // The name comes from the caller (the page's language): the section the table is in, or just "Table".
    expect(render('| a |\n|---|\n| 1 |\n').html).toContain('<div class="table-wrap" tabindex="0" role="region" aria-label="Table">');
    const r = render('## 8. Troubleshooting\n\n| a | b |\n|:-:|--:|\n| 1 | `2` |\n');
    expect(r.html).toContain('<div class="table-wrap" tabindex="0" role="region" aria-label="Table: 8. Troubleshooting">');
    expect(r.html).toContain('<th class="ta-center">a</th><th class="ta-right">b</th>');
    expect(r.html).toContain('<td class="ta-center">1</td><td class="ta-right"><code>2</code></td>');
    expect(r.html).not.toContain('align=');
  });

  it('a line break between two Chinese characters disappears (a browser would show a space), elsewhere it stays', () => {
    // Only between two Chinese characters (inline tags around the break do not matter): "Latin" and "code" keep it.
    const r = render('第一行的結尾\n第二行，**粗體**\n接著，Latin\n文字，`code`\n結尾，**粗**\n`x`。\n\n```\n程式碼\n不變\n```\n');
    expect(r.html).toContain('<p>第一行的結尾第二行，<strong>粗體</strong>接著，Latin\n文字，<code>code</code>\n結尾，<strong>粗</strong>\n<code>x</code>。</p>');
    expect(r.html).toContain('<pre><code>程式碼\n不變\n</code></pre>');
    expect(joinCjkLines('<pre>中\n文</pre>中\n文')).toBe('<pre>中\n文</pre>中文');
  });
});
