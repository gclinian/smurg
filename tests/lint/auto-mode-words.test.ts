// Auto mode (0.6.0, DESIGN D10, D19, D20) is Claude Code's: file edits and simple file commands inside the agent's
// own folder run with no check at all, and only the other commands go to Claude Code's check. A text that says the
// check sees every command promises what nothing does, so no text people read may say it, in either language: the
// catalogs (the wire's, the web app's, the CLI's), the guides, the quick start, the two short pages, the READMEs, the
// product pages, and the changelogs' sections from 0.6.0 on. (docs/GLOSSARY.md names the phrase to forbid it, and is
// not read here.)
import { describe, expect, it } from 'vitest';
import { flat } from './guides.ts';
import { read, repoFiles } from './tree.ts';

/** "checks each command", "checks every command", "every command is checked", and the like. */
const EN = /\bcheck(?:s|ed|ing)?\s+(?:each|every|all)\s+(?:single\s+)?(?:command|tool call)s?\b|\b(?:each|every|all)\s+(?:single\s+)?commands?\s+(?:is|are|gets?|get)\s+checked\b/i;
/** 檢查每一個指令, 檢查每個指令, 每一個指令都會被檢查, and the like. */
const ZH = /檢查(?:每一個|每個|所有的?)指令|(?:每一個|每個|所有的?)指令都(?:會)?(?:被|經過)?(?:檢查|審查)/;

/** The changelogs' sections of 0.6.0 and later, and an [Unreleased] section: what this release and the next say. */
function changelogFrom060(path: string): string {
  const out: string[] = [];
  let keep = false;
  for (const line of read(path).split('\n')) {
    const heading = /^## \[(Unreleased|(\d+)\.(\d+)\.(\d+))\]/.exec(line);
    if (heading !== null) keep = heading[1] === 'Unreleased' || Number(heading[2]) > 0 || Number(heading[3]) >= 6;
    else if (/^## /.test(line)) keep = false;
    if (keep) out.push(line);
  }
  return out.join('\n');
}

function sources(): (readonly [string, string])[] {
  const files = repoFiles();
  const catalogs = files.filter(
    (path) =>
      /^packages\/protocol\/src\/i18n\/messages\/[a-z]+\.ts$/.test(path) ||
      /^apps\/web\/src\/(?:strings\/[a-z]+|features\/[a-z]+\/strings)(?:\.zh-TW)?\.ts$/.test(path) ||
      /^packages\/cli\/src\/i18n\/(?:en|zh-TW)\.ts$/.test(path),
  );
  const documents = [
    'README.md',
    'README.zh-TW.md',
    ...['QUICKSTART', 'HOW-IT-WORKS', 'HOSTING', 'JOINING', 'SECURITY-MODEL'].flatMap((name) => [`docs/${name}.md`, `docs/zh-TW/${name}.md`]),
    'apps/site/public/index.html',
    'apps/site/public/zh-TW/index.html',
  ];
  return [
    ...[...catalogs, ...documents].map((path) => [path, read(path)] as const),
    ...['CHANGELOG.md', 'docs/zh-TW/CHANGELOG.md'].map((path) => [`${path} (0.6.0 and later)`, changelogFrom060(path)] as const),
  ];
}

describe('no text says that auto mode checks every command (DESIGN 0.6.0 D19, D20)', () => {
  it('the lint reads the catalogs and the documents it names, and its two patterns find what they are for', () => {
    const read = sources();
    expect(read.filter(([path]) => path.includes('/i18n/messages/')).length).toBeGreaterThanOrEqual(10);
    expect(read.filter(([path]) => /strings(?:\.zh-TW)?\.ts$/.test(path)).length).toBeGreaterThanOrEqual(20);
    for (const claim of ['Claude Code checks each command', 'smurg checks every command first', 'every command is checked', 'Each command gets checked']) expect(claim).toMatch(EN);
    for (const claim of ['Claude Code 會檢查每一個指令', '檢查每個指令', '每一個指令都會經過檢查']) expect(claim).toMatch(ZH);
    // What the texts do say is not caught: the check decides the OTHER commands; asking for nothing runs every command.
    for (const fine of ["every other command goes to Claude Code's check", 'will run every command as you, with no check', "Claude Code's check decides which commands run"]) expect(fine).not.toMatch(EN);
    for (const fine of ['其他每一個指令都要經過 Claude Code 的檢查', '每一個指令都以你的身分執行，Claude Code 不檢查']) expect(fine).not.toMatch(ZH);
  });

  it('no catalog text, guide, page or changelog of 0.6.0 says it, in English or in zh-TW', () => {
    // (read as one line: a sentence that a document wraps is one sentence)
    const found = sources().flatMap(([path, text]) => {
      const one = flat(text);
      return [EN, ZH].flatMap((pattern) => {
        const at = new RegExp(pattern.source, `${pattern.flags}g`);
        return [...one.matchAll(at)].map((match) => `${path}: …${one.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60)}…`);
      });
    });
    expect(found).toEqual([]);
  });
});
