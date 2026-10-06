// What an agent receives when a question is submitted (ARCHITECTURE §5.9; DESIGN §3.5). PURE and fixed English: the
// answer Claude Code expects is keyed by the question texts and names the labels, and the note next to each answer is
// composed here from COUNTS and the agent's OWN labels. Comments and other people's "Other" texts are never part of
// it: the only words of a person in it are the submitted free-text answer and the note, both written (or copied on
// purpose) by a member with `session.drive`, both through agentText before they get here.
import { AGENT_ROLE_NAMES, agentSafeName, questionTally, votersOf, type Question, type Role } from '@smurg/protocol';

/** One part's answer as it was validated: option indexes, or a free text (cleaned) and who proposed it. */
export type SubmittedPart =
  | { readonly options: readonly number[] }
  | { readonly other: string; readonly otherBy?: { readonly userId: string; readonly displayName: string; readonly role: Role | null } };

export interface ComposedAnswer {
  /** Each question text → the chosen label(s), joined with ", " (Claude Code's own form), or the free text. */
  readonly answers: Record<string, string>;
  /** Each question text → the note the daemon composed. */
  readonly notes: Record<string, string>;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 *   Votes: <label> 2, <label> 1, other 0 (3 of 4 members voted). Decided by <name>.
 *   [Chosen, exactly: ["<label>", "<label>"]]             multi-select only (unambiguous when a label has a comma)
 *   [The answer text was proposed by <name> (<role>).]     an "Other" text of another member was submitted
 *   [Note from <name>: <the decider's note>]
 */
export function composeAnswer(
  question: Pick<Question, 'parts' | 'votes' | 'eligible'>,
  parts: readonly SubmittedPart[],
  note: string | undefined,
  by: { readonly userId: string; readonly displayName: string },
): ComposedAnswer {
  const tally = questionTally(question);
  const voters = votersOf(question);
  const eligible = Math.max(question.eligible, voters.any.length);
  const decidedBy = agentSafeName(by.displayName, by.userId);
  const answers: Record<string, string> = {};
  const notes: Record<string, string> = {};
  question.parts.forEach((part, index) => {
    const submitted = parts[index] as SubmittedPart;
    const row = tally[index] as number[];
    const voted = (voters.byPart[index] as string[]).length;
    const counts = part.options.map((option, optionIndex) => `${option.label} ${row[optionIndex] ?? 0}`).join(', ');
    const lines = [`Votes: ${counts}, other ${row[part.options.length] ?? 0} (${voted} of ${eligible} ${plural(eligible, 'member', 'members')} voted). Decided by ${decidedBy}.`];
    if ('options' in submitted) {
      const labels = submitted.options.map((option) => (part.options[option] as { label: string }).label);
      answers[part.text] = labels.join(', ');
      if (part.multi) lines.push(`[Chosen, exactly: ${JSON.stringify(labels)}]`);
    } else {
      answers[part.text] = submitted.other;
      if (submitted.otherBy !== undefined && submitted.otherBy.userId !== by.userId) {
        const role = submitted.otherBy.role === null ? 'no longer a member' : AGENT_ROLE_NAMES[submitted.otherBy.role];
        lines.push(`[The answer text was proposed by ${agentSafeName(submitted.otherBy.displayName, submitted.otherBy.userId)} (${role}).]`);
      }
    }
    if (note !== undefined) lines.push(`[Note from ${decidedBy}: ${note}]`);
    notes[part.text] = lines.join('\n');
  });
  return { answers, notes };
}
