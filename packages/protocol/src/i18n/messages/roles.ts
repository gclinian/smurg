// Role labels (docs/GLOSSARY.md is binding): one wording for the web app, the CLI and the docs.
// Sentence case; a label, not a sentence (no full stop).
import { message } from '../define.ts';

export const roles = {
  'role.host': message({}, {
    en: () => 'Host',
    'zh-TW': () => '主人',
  }),
  'role.agent': message({}, {
    en: () => 'Agent access',
    'zh-TW': () => '可使用 agent',
  }),
  'role.editor': message({}, {
    en: () => 'Editor',
    'zh-TW': () => '可編輯',
  }),
  'role.viewer': message({}, {
    en: () => 'Viewer',
    'zh-TW': () => '旁觀',
  }),
} as const;
