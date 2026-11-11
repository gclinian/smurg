// The sticky notes (DESIGN 0.8.0 D1, D2): refusals of `sticky.*`. A note's name is a file's name: never translated.
// (The i18n entry imports nothing outside i18n/: the 80 of NOTE_NAME_MAX_CHARS is written here, and the daemon's
// create.test.ts holds it to the limit.)
import { message } from '../define.ts';

/**
 * The rule of D1.2 a refused name breaks, as a person reads it (`sticky.name.invalid`'s `rule`; the daemon maps each
 * `noteNameProblem` to one): its length; a character a path, a link or Markdown reads; white space other than the
 * plain space; a character nobody sees or one written in an unusual form; a space or a dot at either end; a name
 * Claude Code keeps for itself.
 */
export const NOTE_NAME_RULES = ['length', 'markup', 'space', 'unseen', 'edge', 'reserved'] as const;
export type NoteNameRule = (typeof NOTE_NAME_RULES)[number];

const RULES: Readonly<Record<NoteNameRule, { readonly en: string; readonly 'zh-TW': string }>> = {
  length: { en: 'A name has 1 to 80 characters.', 'zh-TW': '名稱要有 1 到 80 個字元' },
  markup: { en: 'A name holds none of / \\ [ ] | # ^ ` * _ ~ < > & @.', 'zh-TW': '名稱不能有 / \\ [ ] | # ^ ` * _ ~ < > & @ 這些符號' },
  space: {
    en: 'The only white space a name holds is the plain space: no tab, no line break, no other kind of space.',
    'zh-TW': '名稱裡的空白只能是一般的空格，不能有 tab、換行或其他種類的空白',
  },
  unseen: {
    en: 'A name holds no invisible or control character, and every letter in its usual form (Unicode NFC, without long runs of accents).',
    'zh-TW': '名稱不能有看不見的字元或控制字元，每個字都要是一般的寫法（Unicode NFC，不能有一長串重音符號）',
  },
  edge: { en: 'A name does not start or end with a space or a dot.', 'zh-TW': '名稱的開頭和結尾不能是空格或句點' },
  reserved: {
    en: 'CLAUDE and CLAUDE.local are kept for Claude Code, which reads those files as instructions.',
    'zh-TW': 'CLAUDE 和 CLAUDE.local 留給 Claude Code 使用，它會把這兩個檔案當作指示來讀',
  },
};

export const sticky = {
  'sticky.name.invalid': message({ rule: 'string' }, {
    en: (p) => {
      const rule = RULES[p.rule as NoteNameRule]?.en;
      return rule === undefined ? 'This is not a name for a sticky note.' : `This is not a name for a sticky note. ${rule}`;
    },
    'zh-TW': (p) => {
      const rule = RULES[p.rule as NoteNameRule]?.['zh-TW'];
      return rule === undefined ? '這不能當作便利貼的名稱' : `這不能當作便利貼的名稱。${rule}`;
    },
  }),
  'sticky.create.exists': message({ name: 'string' }, {
    en: (p) => `There is already a sticky note named ${p.name}.`,
    'zh-TW': (p) => `已經有一張叫做「${p.name}」的便利貼`,
  }),
  'sticky.create.full': message({ max: 'number' }, {
    en: (p) => `There are already ${p.max} sticky notes, the most smurg can list. Delete one in the file tree of Code mode first.`,
    'zh-TW': (p) => `已經有 ${p.max} 張便利貼，這是 smurg 能列出的上限。請先在手寫 code 模式的檔案樹刪掉一張`,
  }),
} as const;
