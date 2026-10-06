// The Markdown renderer in Traditional Chinese: its own few words are translated, the text never is.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useTestLocale } from '../../testing/locale.ts';
import { Markdown } from './index.ts';

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
});
