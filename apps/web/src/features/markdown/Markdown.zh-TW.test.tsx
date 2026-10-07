// The Markdown renderer in Traditional Chinese: its own few words are translated, the text never is.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { Markdown } from './index.ts';
import { namesAnotherPlace } from './links.ts';

useTestLocale('zh-TW');

describe('Markdown (zh-TW)', () => {
  it('names links, images, code and tasks in Traditional Chinese and leaves the text as written', () => {
    const { container } = render(<Markdown text={['購物車的 [規格](https://example.com/spec) ![流程圖](https://example.com/a.png)', '', '```ts', 'const a = 1;', '```', '', '- [x] 已寫測試', '- [ ] 待審查'].join('\n')} />);
    const [link, image] = [...container.querySelectorAll('a')];
    expect(link?.textContent).toBe('規格');
    expect(link?.getAttribute('title')).toBe('https://example.com/spec（在新分頁開啟）');
    expect(image?.textContent).toBe('圖片：流程圖');
    expect(image?.getAttribute('title')).toContain('這裡不會載入圖片');
    expect(container.querySelector('pre')?.getAttribute('aria-label')).toBe('程式碼（ts）');
    expect([...container.querySelectorAll('input')].map((box) => box.getAttribute('aria-label'))).toEqual(['已完成', '未完成']);
    expect(container.querySelector('img')).toBeNull();
  });

  it('Chinese around a name is not part of the name, and a Chinese full stop is a full stop (review R4-05)', () => {
    const elsewhere = 'https://evil.example/';
    // Words a person writes in Chinese: none of them is the address of another place.
    for (const words of ['請看README.md的說明', '請看 README.md 的說明。', '看這裡。然後登入', '第1.2節', '重量3.5公斤', '等等...然後', 'Node.js的文件', '版本v1.2。', '用法：a.b()。', '規格（SPEC.md）']) {
      expect(namesAnotherPlace(words, elsewhere), words).toBe(false);
    }
    // An address glued to Chinese is still read as the address it is …
    expect(namesAnotherPlace('請到github.com登入', elsewhere)).toBe(true);
    expect(namesAnotherPlace('請到github.com登入', 'https://github.com/login')).toBe(false);
    expect(namesAnotherPlace('請到github。com登入', elsewhere)).toBe(true);
    // … and a name in Chinese with a dot directly beside it is an address that cannot be taken at its word.
    for (const words of ['台灣銀行.tw', '請到台灣銀行.tw登入', '中文.台灣', 'www.例子.com', '設定.json']) {
      expect(namesAnotherPlace(words, elsewhere), words).toBe(true);
    }
    const { container } = render(<Markdown text="[台灣銀行.tw](https://evil.example/login) [請看README.md的說明](https://example.com/readme)" />);
    expect(container.textContent).toBe('台灣銀行.tw (https://evil.example/login) 請看README.md的說明');
  });

  it('says in Traditional Chinese that a text is shown as it was written', () => {
    const text = `${'>'.repeat(200)} 太深了`;
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector('.md-note')?.textContent).toBe('以原文顯示：這段文字太長或層次太深，無法排版。');
    expect(container.querySelector('.md-plain')?.textContent).toBe(text);
  });
});
