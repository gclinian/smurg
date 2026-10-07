// PURE. Who is responsible for which work item (ARCHITECTURE §5.10; design §4.4). The agent knows the items, the
// daemon knows the people: the daemon tells the agent who is present, the agent proposes (`propose_split`), and this
// file checks the proposal against the members and fills what is left with an even split:
//
//   weight(item)  = s:1, m:2, l:3
//   groups        = the connected components of the dependency graph, heaviest first, then by the first item's number
//   each group goes to the person with the smallest load so far (ties: fewer items, then who joined earlier);
//   a group heavier than 1.5 x (total weight / number of people) is split item by item instead.
//
// Only members with agent access are ever suggested: a responsible Editor could not allow their agent's commands.
import { normalized } from '@smurg/protocol';

export interface SplitPerson {
  readonly userId: string;
  /** The name the agent was given for this person (`agentSafeName`). */
  readonly name: string;
  readonly joinedAt: number;
}

export interface SplitItem {
  readonly id: string;
  readonly number: number;
  readonly size: 's' | 'm' | 'l';
  readonly dependsOn: readonly string[];
}

export const SIZE_WEIGHT: Readonly<Record<SplitItem['size'], number>> = Object.freeze({ s: 1, m: 2, l: 3 });
/** A group heavier than this many times the average load per person is split item by item. */
export const GROUP_SPLIT_FACTOR = 1.5;

function fold(name: string): string {
  return normalized(name, 'NFKC').trim().toLowerCase();
}

export interface CheckedProposal {
  /** item id → user id, for the pairs that are kept. */
  readonly kept: ReadonlyMap<string, string>;
  /** Pairs whose person matched nobody, or more than one person. */
  readonly unknownPeople: number;
  /** Pairs whose item is not one that may be proposed for (unknown, started, chosen by a person), or a repeated item. */
  readonly unknownItems: number;
}

/**
 * The agent's proposal against the people it was told about: a pair is kept when its id is one of `eligibleIds` and
 * its person matches EXACTLY ONE of `people`, comparing names case-insensitively. Everything else is dropped and
 * counted. The first pair of an item wins.
 */
export function checkProposal(eligibleIds: ReadonlySet<string>, people: readonly SplitPerson[], proposal: readonly { readonly id: string; readonly person: string }[]): CheckedProposal {
  const kept = new Map<string, string>();
  let unknownPeople = 0;
  let unknownItems = 0;
  for (const pair of proposal) {
    if (!eligibleIds.has(pair.id) || kept.has(pair.id)) {
      unknownItems += 1;
      continue;
    }
    const wanted = fold(pair.person);
    const matches = people.filter((person) => fold(person.name) === wanted);
    if (matches.length !== 1) {
      unknownPeople += 1;
      continue;
    }
    kept.set(pair.id, (matches[0] as SplitPerson).userId);
  }
  return { kept, unknownPeople, unknownItems };
}

interface Load {
  weight: number;
  items: number;
}

/**
 * smurg's even split of `items` over `people`. `loads`: what each person already carries (the agent's kept pairs,
 * items chosen by hand, items that run), so the whole plan comes out even, not only this call. Without people nothing
 * is assigned.
 */
export function evenSplit(items: readonly SplitItem[], people: readonly SplitPerson[], loads: ReadonlyMap<string, { readonly weight: number; readonly items: number }> = new Map()): Map<string, string> {
  const out = new Map<string, string>();
  if (people.length === 0 || items.length === 0) return out;
  const load = new Map<string, Load>(people.map((person) => [person.userId, { weight: loads.get(person.userId)?.weight ?? 0, items: loads.get(person.userId)?.items ?? 0 }]));
  const lightest = (): SplitPerson =>
    [...people].sort((a, b) => {
      const la = load.get(a.userId) as Load;
      const lb = load.get(b.userId) as Load;
      return la.weight - lb.weight || la.items - lb.items || a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : 1);
    })[0] as SplitPerson;
  const give = (item: SplitItem, person: SplitPerson): void => {
    out.set(item.id, person.userId);
    const entry = load.get(person.userId) as Load;
    entry.weight += SIZE_WEIGHT[item.size];
    entry.items += 1;
  };

  // Connected components of the dependency graph, over the items that are being split.
  const byId = new Map(items.map((item) => [item.id, item]));
  const neighbours = new Map<string, Set<string>>(items.map((item) => [item.id, new Set<string>()]));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) continue;
      neighbours.get(item.id)?.add(dependency);
      neighbours.get(dependency)?.add(item.id);
    }
  }
  const seen = new Set<string>();
  const groups: SplitItem[][] = [];
  for (const item of [...items].sort((a, b) => a.number - b.number)) {
    if (seen.has(item.id)) continue;
    const group: SplitItem[] = [];
    const stack = [item.id];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(byId.get(id) as SplitItem);
      for (const next of neighbours.get(id) ?? []) stack.push(next);
    }
    groups.push(group.sort((a, b) => a.number - b.number));
  }
  const weightOf = (group: readonly SplitItem[]): number => group.reduce((sum, item) => sum + SIZE_WEIGHT[item.size], 0);
  const total = weightOf(items);
  const limit = GROUP_SPLIT_FACTOR * (total / people.length);
  groups.sort((a, b) => weightOf(b) - weightOf(a) || (a[0] as SplitItem).number - (b[0] as SplitItem).number);
  for (const group of groups) {
    if (weightOf(group) > limit) {
      for (const item of group) give(item, lightest());
      continue;
    }
    const person = lightest();
    for (const item of group) give(item, person);
  }
  return out;
}
