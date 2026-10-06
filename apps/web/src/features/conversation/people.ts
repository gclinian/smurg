// The people of the workspace as the conversation column needs them: who can be named with "@", who has agent
// access, who may be made responsible. Read from the presence store (every member the daemon told this client about).
import { MENTIONS_PER_TEXT_MAX, can, type PresenceMember, type Role } from '@smurg/protocol';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';

export interface Person {
  readonly userId: string;
  readonly displayName: string;
  readonly role: Role;
  readonly color: string;
  readonly online: boolean;
}

const toPerson = (member: PresenceMember): Person => ({ userId: member.userId, displayName: member.displayName, role: member.role, color: member.color, online: member.online });

function samePeople(a: readonly Person[], b: readonly Person[]): boolean {
  return a.length === b.length && a.every((person, index) => shallowEqual(person, b[index] as Person));
}

/** Every member the workspace knows, in the daemon's order (stable while nobody changes). */
export function usePeople(): readonly Person[] {
  return useStore(useStores().presence, (state) => state.members.map(toPerson), samePeople);
}

/** Members with agent access (the host and the role Agent access): who a message reaches an agent through. */
export const withAgentAccess = (people: readonly Person[]): Person[] => people.filter((person) => can(person.role, 'session.drive'));

/** Members who vote, comment and may be made responsible (everyone but viewers). */
export const whoDiscuss = (people: readonly Person[]): Person[] => people.filter((person) => can(person.role, 'discuss'));

export const personOf = (people: readonly Person[], userId: string | null | undefined): Person | undefined =>
  userId === null || userId === undefined ? undefined : people.find((person) => person.userId === userId);

/**
 * The ids of the members a text names with "@" (the daemon keeps an id only when the text contains `@<their display
 * name>`), longest names first so "@Mei Lin" is not read as "@Mei", at most MENTIONS_PER_TEXT_MAX.
 */
export function mentionsIn(text: string, people: readonly Person[]): string[] {
  if (!text.includes('@')) return [];
  const found: string[] = [];
  let rest = text;
  for (const person of [...people].sort((a, b) => b.displayName.length - a.displayName.length)) {
    const needle = `@${person.displayName}`;
    if (person.displayName === '' || !rest.includes(needle)) continue;
    found.push(person.userId);
    // What a longer name used is not left for a shorter one that begins it.
    rest = rest.split(needle).join(' ');
    if (found.length === MENTIONS_PER_TEXT_MAX) break;
  }
  return found;
}

export interface MentionQuery {
  /** The index of the "@". */
  readonly start: number;
  /** What was typed after it, up to the caret. */
  readonly query: string;
}

/**
 * The mention being typed at the caret: an "@" at the start of the text or after white space, followed by at most
 * two words and no line break. Null when the caret is not in one.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  if (start > 0 && !/\s/u.test(before[start - 1] as string)) return null;
  const query = before.slice(start + 1);
  if (query.includes('\n') || query.split(' ').length > 2 || query.length > 60) return null;
  return { start, query };
}

/** The people a query offers: those whose name starts with it (any case), then those that contain it. */
export function matchPeople(people: readonly Person[], query: string, selfUserId: string | null): Person[] {
  const needle = query.trim().toLocaleLowerCase();
  const others = people.filter((person) => person.userId !== selfUserId);
  if (needle === '') return others;
  const starts = others.filter((person) => person.displayName.toLocaleLowerCase().startsWith(needle));
  const contains = others.filter((person) => !starts.includes(person) && person.displayName.toLocaleLowerCase().includes(needle));
  return [...starts, ...contains];
}

/** The text with the mention being typed replaced by `@name ` and where the caret goes. */
export function applyMention(text: string, query: MentionQuery, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `;
  const after = text.slice(caret).replace(/^ /, '');
  return { text: text.slice(0, query.start) + inserted + after, caret: query.start + inserted.length };
}
