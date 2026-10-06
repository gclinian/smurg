// Votes on a question (ARCHITECTURE §5.9): who has voted, the tally and the leading answer, as pure functions. The
// conversation module (the note for the agent, the answer's tally, reminders, `eligible`), the inbox (`voted`,
// `allVoted`, `leading`) and the web (the counts on a card, the prefilled answer) all use these and nothing else, so
// a card, an inbox row and what the agent is told can never disagree.
//
// One member has at most one vote per part. A member HAS VOTED once they voted on every part of the question.
import type { Question } from './schema/conversation.ts';

/** The facts these functions read: any `Question`, or a client's own copy while it is open. */
export type VoteFacts = Pick<Question, 'parts' | 'votes'>;

/** Per part: one count per option, then the count of "Other" (the shape of `Question.answer.tally` and `previous.tally`). */
export function questionTally(question: VoteFacts): number[][] {
  return question.parts.map((part, index) => {
    const counts = part.options.map(() => 0);
    let other = 0;
    for (const vote of question.votes) {
      if (vote.part !== index) continue;
      if (vote.options === undefined) other += 1;
      else for (const option of new Set(vote.options)) if (option < counts.length) counts[option] = (counts[option] as number) + 1;
    }
    return [...counts, other];
  });
}

export interface Voters {
  /** Per part: the members who voted on it, in the order of their votes. */
  readonly byPart: string[][];
  /** Members who voted on at least one part (they count toward `Question.eligible` also when offline). */
  readonly any: string[];
  /** Members who voted on every part: who "has voted" ("3 of 4 voted", the inbox's `vote` item leaves). */
  readonly complete: string[];
}

export function votersOf(question: VoteFacts): Voters {
  const byPart = question.parts.map((_, index) => [...new Set(question.votes.filter((vote) => vote.part === index).map((vote) => vote.userId))]);
  const any = [...new Set(question.votes.filter((vote) => vote.part < question.parts.length).map((vote) => vote.userId))];
  const complete = any.filter((userId) => byPart.every((voters) => voters.includes(userId)));
  return { byPart, any, complete };
}

/** Everyone eligible has voted (on every part). False while nobody is eligible. */
export function allVoted(question: VoteFacts & Pick<Question, 'eligible'>): boolean {
  return question.eligible > 0 && votersOf(question).complete.length >= question.eligible;
}

/**
 * Per part, the answer the votes lead to, in the form `question.submit` takes, or null when none leads:
 *  - a single-select part: the option with strictly more votes than every other option and than "Other" (a tie, or
 *    no vote: null);
 *  - a multi-select part: the options that more than half of the members who voted on that part chose, in option
 *    order (none: null).
 * "Other" never leads: it is several people's own words, not one answer.
 */
export function leadingAnswer(question: VoteFacts): ({ options: number[] } | null)[] {
  const tally = questionTally(question);
  const voters = votersOf(question).byPart;
  return question.parts.map((part, index) => {
    const row = tally[index] as number[];
    const counts = row.slice(0, part.options.length);
    const other = row[part.options.length] as number;
    if (part.multi) {
      const half = (voters[index] as string[]).length / 2;
      const options = counts.flatMap((count, option) => (count > half ? [option] : []));
      return options.length === 0 ? null : { options };
    }
    const top = Math.max(0, ...counts);
    if (top === 0 || top <= other || counts.filter((count) => count === top).length !== 1) return null;
    return { options: [counts.indexOf(top)] };
  });
}

/**
 * The label an inbox row names as leading (`InboxItem.leading`): the leading option of the FIRST part, when exactly
 * one option leads there. Undefined on a tie, before anyone voted, and when several options of a multi-select lead.
 */
export function leadingLabel(question: VoteFacts): string | undefined {
  const first = leadingAnswer(question)[0];
  if (first === null || first === undefined || first.options.length !== 1) return undefined;
  return question.parts[0]?.options[first.options[0] as number]?.label;
}
