// The sticky notes (DESIGN 0.8.0 D1, D2, D4): refusals of `sticky.*`. A note's name is a file's name: never translated.
// Feedback has the GLOSSARY's word; its decisions are the suggestion's words (Accept, Reject) in both languages.
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

/**
 * The steps of "Build this" that come after the topic exists (`sticky.build.failedAt`'s `step`, D5.4): the record of
 * the build on the sticky note, the topic's SPEC.md, its PLAN.md. A step that fails leaves the topic as it is.
 */
export const BUILD_STEPS = ['record', 'spec', 'plan'] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];

const BUILD_STEP_TEXTS: Readonly<Record<BuildStep, { readonly en: string; readonly 'zh-TW': string }>> = {
  record: {
    en: 'The topic was made and is in the sessions view, but smurg could not record on the sticky note that it was built from it.',
    'zh-TW': '主題已經建立，可以在 session 畫面找到，但 smurg 沒有在便利貼上記下這個主題是從它建立的',
  },
  spec: {
    en: 'The topic was made and is in the sessions view, but its SPEC.md was not written.',
    'zh-TW': '主題已經建立，可以在 session 畫面找到，但它的 SPEC.md 沒有寫入',
  },
  plan: {
    en: 'The topic was made and is in the sessions view, with its SPEC.md, but its PLAN.md was not written.',
    'zh-TW': '主題已經建立，可以在 session 畫面找到，SPEC.md 也寫好了，但它的 PLAN.md 沒有寫入',
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

  // ---- feedback on sticky notes (D4) ----------------------------------------------------------------------------
  'sticky.note.missing': message({ name: 'string' }, {
    en: (p) => `There is no sticky note named ${p.name}.`,
    'zh-TW': (p) => `沒有叫做「${p.name}」的便利貼`,
  }),
  'sticky.feedback.notFound': message({}, {
    en: () => 'That feedback was not found.',
    'zh-TW': () => '找不到這則意見',
  }),
  'sticky.feedback.notWaiting': message({}, {
    en: () => 'This feedback was already accepted, rejected or withdrawn.',
    'zh-TW': () => '這則意見已經被採用、不採用或撤回了',
  }),
  'sticky.feedback.accepting': message({}, {
    en: () => 'This feedback is being accepted right now.',
    'zh-TW': () => '這則意見正在採用中',
  }),
  'sticky.feedback.authorOnly': message({}, {
    en: () => 'Only the person who wrote this feedback can withdraw it.',
    'zh-TW': () => '只有寫這則意見的人可以撤回它',
  }),
  // Removing hidden characters only shortens a text (the wire refused a longer one already): it grows when agentText
  // puts "> " in front of each line that looks like a message header.
  'sticky.feedback.invalidText': message({}, {
    en: () => 'The feedback is blank, or too long once smurg marks the lines that look like a message header ("> " in front).',
    'zh-TW': () => '意見內容是空白的，或是 smurg 在看起來像訊息標頭的行前面加上「> 」之後太長了',
  }),
  'sticky.feedback.tooManyWaiting': message({ max: 'number' }, {
    en: (p) => `You have ${p.max} pieces of feedback waiting for a decision, the most one person may have. Wait for a decision, or withdraw one.`,
    'zh-TW': (p) => `你已經有 ${p.max} 則意見在等待處理，這是一個人的上限。請等候決定，或撤回其中一則`,
  }),
  'sticky.feedback.full': message({}, {
    en: () => 'Too much feedback is waiting for a decision. Wait until some of it is accepted or rejected.',
    'zh-TW': () => '等待處理的意見太多了，請等一些意見被採用或不採用之後再寫',
  }),
  'sticky.feedback.noAssistant': message({}, {
    en: () => 'Claude for the sticky notes is not running. Start it first: accepted feedback goes to it.',
    'zh-TW': () => '便利貼的 Claude 沒有在執行。請先啟動它：採用的意見會交給它',
  }),

  // ---- Build this (D5) ------------------------------------------------------------------------------------------
  'sticky.spec.oversized': message({ name: 'string', maxKiB: 'number' }, {
    en: (p) => `The sticky note ${p.name} is larger than ${p.maxKiB} KiB, so it cannot go into a spec.`,
    'zh-TW': (p) => `便利貼「${p.name}」超過 ${p.maxKiB} KiB，所以不能放進 spec`,
  }),
  'sticky.spec.unreadable': message({ name: 'string' }, {
    en: (p) => `smurg could not read the sticky note ${p.name} for you, so it cannot go into a spec.`,
    'zh-TW': (p) => `smurg 無法替你讀取便利貼「${p.name}」，所以它不能放進 spec`,
  }),
  'sticky.spec.tooLarge': message({ maxKiB: 'number' }, {
    en: (p) => `This sticky note and the sticky notes it links to are larger than ${p.maxKiB} KiB together, too much for one spec. Make them shorter, or link fewer of them.`,
    'zh-TW': (p) => `這張便利貼和它連到的便利貼加起來超過 ${p.maxKiB} KiB，一份 spec 放不下。請把它們寫短一點，或少連幾張`,
  }),
  'sticky.build.noteChanged': message({}, {
    en: () => 'This sticky note or a sticky note it links to changed after the text was shown. Read the new text, then confirm again.',
    'zh-TW': () => '顯示這段文字之後，這張便利貼或它連到的便利貼改了。請看新的文字，再確認一次',
  }),
  'sticky.build.slugUnavailable': message({ slug: 'string' }, {
    en: (p) => `smurg found no free folder for the topic: specs/${p.slug} and the numbered ones up to specs/${p.slug}-9 are all taken.`,
    'zh-TW': (p) => `smurg 找不到可以給這個主題用的資料夾：specs/${p.slug} 和編號到 specs/${p.slug}-9 的資料夾都已經被用掉了`,
  }),
  'sticky.build.failedAt': message({ step: 'string' }, {
    en: (p) => BUILD_STEP_TEXTS[p.step as BuildStep]?.en ?? 'The topic was made and is in the sessions view, but a later step did not go through.',
    'zh-TW': (p) => BUILD_STEP_TEXTS[p.step as BuildStep]?.['zh-TW'] ?? '主題已經建立，可以在 session 畫面找到，但後面的步驟沒有完成',
  }),
} as const;
