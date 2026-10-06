// The Markdown renderer (DESIGN §5.5, §5.11 "Markdown (no HTML, no image request, link schemes)").
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { decodeEntities } from './entities.ts';
import { Markdown, STREAM_PARSE_MS, StreamingMarkdown, findMentions, safeHref, type MarkdownPaths, type PathMatch } from './index.ts';
import { parseStreaming } from './Markdown.tsx';
import { stableLength } from './stream.ts';

const html = (text: string, props: Partial<Parameters<typeof Markdown>[0]> = {}): HTMLElement => {
  const { container } = render(<Markdown text={text} {...props} />);
  return container.firstElementChild as HTMLElement;
};

describe('Markdown: what it renders', () => {
  it('renders the usual blocks and inline marks as elements', () => {
    const root = html(['# Plan', '', 'Use **one** store, *not* two, ~~three~~.', '', '- first', '- second', '', '3. third', '4. fourth', '', '> quoted', '', '---'].join('\n'));
    expect(root.className).toBe('md-body');
    expect(root.querySelector('h3')?.textContent).toBe('Plan');
    expect(root.querySelector('p')?.innerHTML).toBe('Use <strong>one</strong> store, <em>not</em> two, <del>three</del>.');
    expect([...root.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['first', 'second']);
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(root.querySelector('blockquote p')?.textContent).toBe('quoted');
    expect(root.querySelector('hr')).toBeTruthy();
  });

  it('places headings under the level it is given and never above h2 or below h6', () => {
    expect(html('# a\n\n## b\n\n### c\n\n#### d\n\n##### e', { headingBase: 4 }).innerHTML.match(/<h\d/g)).toEqual(['<h4', '<h5', '<h6', '<h6', '<h6']);
    expect(html('# a', { headingBase: 1 }).querySelector('h2')).toBeTruthy();
  });

  it('shows a code block as plain monospace text, with its language named', () => {
    const root = html(['```ts', 'const a = "<b>" & 1;', '```'].join('\n'));
    const pre = root.querySelector('pre');
    expect(pre?.textContent).toBe('const a = "<b>" & 1;');
    expect(pre?.getAttribute('aria-label')).toBe('Code (ts)');
    expect(pre?.querySelector('code')?.children).toHaveLength(0);
    expect(html('    indented').querySelector('pre')?.getAttribute('aria-label')).toBe('Code');
  });

  it('renders tables, task lists and nested lists', () => {
    const root = html(['| a | b |', '|:--|--:|', '| 1 | `2` |', '', '- [x] done', '- [ ] open', '', '- outer', '  - inner'].join('\n'));
    expect([...root.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['a', 'b']);
    expect((root.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');
    expect(root.querySelector('td code')?.textContent).toBe('2');
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((box) => [box.checked, box.disabled, box.getAttribute('aria-label')])).toEqual([[true, true, 'Done'], [false, true, 'Not done']]);
    expect(root.querySelector('ul ul li')?.textContent).toBe('inner');
  });

  it('decodes what the lexer escaped, once', () => {
    expect(html('a & b < c > d "e" \'f\'').textContent).toBe('a & b < c > d "e" \'f\'');
    expect(html('`a && b < c`').querySelector('code')?.textContent).toBe('a && b < c');
    expect(html('&amp;lt; &copy; &#65; &#x42; &unknown;').textContent).toBe('&lt; © A B &unknown;');
    expect(html('\\*not emphasis\\*').textContent).toBe('*not emphasis*');
    expect(decodeEntities('&#0; &#xD800; &#1114112;')).toBe('&#0; &#xD800; &#1114112;');
  });

  it('keeps a line break a person typed when asked to', () => {
    expect(html('one\ntwo').querySelectorAll('br')).toHaveLength(0);
    expect(html('one\ntwo', { breaks: true }).querySelectorAll('br')).toHaveLength(1);
  });
});

describe('Markdown: nothing of the text becomes markup or a request', () => {
  it('shows raw HTML as the text it is', () => {
    const root = html(['<script>alert(1)</script>', '', 'An <img src=x onerror=alert(1)> and <b>bold</b>.', '', '<div onclick="x()">block</div>'].join('\n'));
    expect(root.querySelector('script, img, b, div[onclick], iframe')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('An <img src=x onerror=alert(1)> and <b>bold</b>.');
    expect(root.textContent).toContain('<div onclick="x()">block</div>');
  });

  it('never loads an image: it is a link with its alt text', () => {
    const root = html('![The diagram](https://example.com/a.png) and ![](https://example.com/b.png) and ![local](./c.png)');
    expect(root.querySelector('img')).toBeNull();
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Image: The diagram', 'https://example.com/a.png'],
      ['Image', 'https://example.com/b.png'],
    ]);
    expect(links[0]?.getAttribute('title')).toContain('Images are not loaded here');
    // An image whose address is not a link stays its alt text.
    expect(root.querySelector('.md-image')?.textContent).toBe('Image: local');
  });

  it('makes a link only of http, https and mailto, in a new tab, with its address shown', () => {
    const root = html(
      [
        '[site](https://example.com/a?b=1&c=2) <https://auto.example/x> www.example.org',
        '[mail](mailto:amy@example.com) <amy@example.com>',
        '[js](javascript:alert(1)) [data](data:text/html,x) [rel](../up) [frag](#top) [file](file:///etc/passwd) [vs](vscode://x)',
      ].join('\n\n'),
    );
    const links = [...root.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a?b=1&c=2',
      'https://auto.example/x',
      'http://www.example.org/',
      'mailto:amy@example.com',
      'mailto:amy@example.com',
    ]);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('data-address')).toBe(link.getAttribute('href'));
      expect(link.getAttribute('title')).toBe(`${link.getAttribute('href')} (opens in a new tab)`);
    }
    // The refused ones keep their text.
    expect(root.textContent).toContain('js data rel frag file vs');
  });

  it('refuses addresses that hide where they lead', () => {
    expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeHref('HTTP://EXAMPLE.com')).toBe('http://example.com/');
    expect(safeHref('mailto:amy@example.com')).toBe('mailto:amy@example.com');
    for (const bad of ['', ' https://a.example', 'java\tscript:alert(1)', 'javascript:alert(1)', 'data:text/html,x', '//example.com', '/a', 'a.html', '#x', 'https:example.com', 'http:///x', 'https://user:pw@example.com/', 'ftp://example.com', 'blob:https://example.com/1', null, undefined]) {
      expect(safeHref(bad), String(bad)).toBeNull();
    }
  });
});

describe('Markdown: paths and mentions', () => {
  const adapter = (known: Record<string, () => void>): MarkdownPaths & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      find(text) {
        const found: PathMatch[] = [];
        for (const match of text.matchAll(/[\w./-]+\.ts(?::\d+)?/g)) found.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
        return found;
      },
      async resolve(match) {
        asked.push(match.text);
        const open = known[match.text];
        return open === undefined ? null : { label: match.text.replace(/:\d+$/, ''), open };
      },
    };
  };

  it('turns a path the adapter resolves into a button that opens it, in text and in inline code', async () => {
    const open = vi.fn();
    const paths = adapter({ 'src/cart/total.ts:12': open, 'src/a.ts': open });
    const view = render(<Markdown text={'See src/cart/total.ts:12 and `src/a.ts`, not src/gone.ts.'} paths={paths} />);
    const first = await screen.findByRole('button', { name: 'src/cart/total.ts:12' });
    expect(first.getAttribute('title')).toBe('Open src/cart/total.ts');
    fireEvent.click(first);
    expect(open).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('code button')?.textContent).toBe('src/a.ts');
    expect(screen.queryByRole('button', { name: 'src/gone.ts' })).toBeNull();
    expect(view.container.textContent).toBe('See src/cart/total.ts:12 and src/a.ts, not src/gone.ts.');
    expect(paths.asked.sort()).toEqual(['src/a.ts', 'src/cart/total.ts:12', 'src/gone.ts']);
  });

  it('never looks for paths inside a link or a code block', async () => {
    const paths = adapter({});
    render(<Markdown text={['[src/a.ts](https://example.com)', '', '```', 'src/b.ts', '```'].join('\n')} paths={paths} />);
    await act(async () => {});
    expect(paths.asked).toEqual([]);
  });

  it('marks the members it was told about when they are named with @', () => {
    const names = ['Mei', 'Mei Lin', 'Ian'];
    expect(findMentions('@Mei Lin and @Ian, not @Ken or mei@example.com', names)).toEqual([{ start: 0, end: 8 }, { start: 13, end: 17 }]);
    const root = html('@Mei Lin please look, cc @Ian', { mentions: names });
    expect([...root.querySelectorAll('.md-mention')].map((node) => node.textContent)).toEqual(['@Mei Lin', '@Ian']);
    expect(html('`@Ian`', { mentions: names }).querySelector('.md-mention')).toBeNull();
    expect(findMentions('@Ian', [])).toEqual([]);
  });
});

describe('streaming text', () => {
  it('finds the cut before which the text never parses differently', () => {
    expect(stableLength('')).toBe(0);
    expect(stableLength('One paragraph\nstill the same')).toBe(0);
    expect(stableLength('First.\n\nSecond')).toBe(8);
    expect(stableLength('First.\n\nSecond.\n\nThird')).toBe(17);
    // A list item, a quote, a table row or an indented line may still belong to what is above.
    expect(stableLength('Intro\n\n- item\n\n- item two')).toBe(0);
    expect(stableLength('- item\n\n  continued\n\nAfter')).toBe(21);
    expect(stableLength('Intro\n\n> quote')).toBe(0);
    expect(stableLength('Intro\n\n1')).toBe(0);
    expect(stableLength('Intro\n\n1. one\n')).toBe(0);
    expect(stableLength('Intro\n\n1 is a number\n')).toBe(7);
    // Nothing inside a fenced block is a cut, blank lines included.
    expect(stableLength('Code:\n\n```ts\nconst a = 1;\n\nconst b = 2;')).toBe(7);
    expect(stableLength('Code:\n\n```ts\na\n\nb\n```\n\nDone')).toBe(23);
    expect(stableLength('~~~\na\n```\n\nb\n~~~\n\nDone')).toBe(18);
    // Continuing from an earlier cut gives the same answer as starting over.
    const text = 'First.\n\nSecond.\n\nThird.\n\nFourth';
    expect(stableLength(text, 8)).toBe(stableLength(text));
    expect(stableLength('First.\n\nSecond', 8)).toBe(8);
  });

  it('parses the stable part once and only the rest again', () => {
    const first = parseStreaming('First.\n\nSecond', { text: '', stableText: '', stable: [], tail: [] });
    expect(first.stableText).toBe('First.\n\n');
    const second = parseStreaming('First.\n\nSecond one.\n\nThird', first);
    expect(second.stable[0]).toBe(first.stable[0]);
    expect(second.stableText).toBe('First.\n\nSecond one.\n\n');
    expect(parseStreaming(second.text, second)).toBe(second);
    // A text that does not continue the old one (a new watch gave the block again) starts over.
    const other = parseStreaming('Different.\n\nText', second);
    expect(other.stableText).toBe('Different.\n\n');
    expect(other.stable[0]).not.toBe(first.stable[0]);
  });

  function stream(initial = '') {
    let text = initial;
    let now = 0;
    const listeners = new Set<() => void>();
    const pending: { at: number; run: () => void }[] = [];
    const timers = {
      now: () => now,
      setTimeout(run: () => void, ms: number) {
        const entry = { at: now + ms, run };
        pending.push(entry);
        return entry;
      },
      clearTimeout(handle: unknown) {
        const index = pending.indexOf(handle as { at: number; run: () => void });
        if (index >= 0) pending.splice(index, 1);
      },
    };
    return {
      timers,
      read: () => text,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      append(more: string) {
        text += more;
        for (const listener of [...listeners]) listener();
      },
      advance(ms: number) {
        now += ms;
        for (const entry of [...pending]) {
          if (entry.at > now) continue;
          pending.splice(pending.indexOf(entry), 1);
          entry.run();
        }
      },
      get timersPending() {
        return pending.length;
      },
      get listeners() {
        return listeners.size;
      },
    };
  }

  it('shows new text at once and parses it at most every STREAM_PARSE_MS', () => {
    const source = stream('Then the **test**');
    const view = render(<StreamingMarkdown read={source.read} subscribe={source.subscribe} timers={source.timers} />);
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.className).toBe('md-body md-body--streaming');
    expect(root.innerHTML).toBe('<p>Then the <strong>test</strong></p>');

    // Too soon for a parse: the text is appended to the last block as it is, and is parsed when the time has come.
    act(() => source.append(' is `wrong`'));
    expect(root.textContent).toBe('Then the test is `wrong`');
    expect(root.querySelector('code')).toBeNull();
    act(() => source.append(', not the page.'));
    expect(root.textContent).toBe('Then the test is `wrong`, not the page.');
    expect(source.timersPending).toBe(1);
    act(() => source.advance(STREAM_PARSE_MS));
    expect(root.innerHTML).toBe('<p>Then the <strong>test</strong> is <code class="md-code">wrong</code>, not the page.</p>');

    // After the interval a new piece is parsed right away.
    act(() => source.advance(STREAM_PARSE_MS));
    act(() => source.append('\n\nNext'));
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(source.timersPending).toBe(0);

    view.unmount();
    expect(source.listeners).toBe(0);
  });

  it('keeps the pending text inside a code block that is being written', () => {
    const source = stream('```\nline one\n');
    const view = render(<StreamingMarkdown read={source.read} subscribe={source.subscribe} timers={source.timers} />);
    const root = view.container.firstElementChild as HTMLElement;
    act(() => source.append('line two'));
    expect(root.querySelector('pre > code')?.textContent).toBe('line one\nline two');
    act(() => source.advance(STREAM_PARSE_MS));
    expect(root.querySelector('pre > code')?.textContent).toBe('line one\nline two');
    expect(root.querySelectorAll('pre')).toHaveLength(1);
  });
});
