// The sticky notes (DESIGN 0.8.0 D1, D2): refusals of `sticky.*`. A note's name is a file's name: never translated.
import { message } from '../define.ts';

export const sticky = {
  'sticky.name.invalid': message({}, {
    en: () => 'This is not a name for a sticky note. Use at most 80 characters, none of / \\ [ ] | # ^ ` * _ ~ < > & @, and no space or dot at the start or the end.',
    'zh-TW': () => '這不能當作便利貼的名稱。最多 80 個字元，不能有 / \\ [ ] | # ^ ` * _ ~ < > & @ 這些符號，開頭和結尾也不能是空格或句點',
  }),
  'sticky.create.exists': message({ name: 'string' }, {
    en: (p) => `There is already a sticky note named ${p.name}.`,
    'zh-TW': (p) => `已經有一張叫做「${p.name}」的便利貼`,
  }),
} as const;
