import { describe, expect, it } from 'vitest';
import { questionSchema, questionTallySchema, type Question } from './schema/conversation.ts';
import { allVoted, leadingAnswer, leadingLabel, questionTally, votersOf } from './votes.ts';

const option = (label: string) => ({ label, description: '' });
const single = { header: 'Cart', text: 'Where is the cart kept?', multi: false, options: [option('On the server'), option('In the browser'), option('Both')] };
const multi = { header: 'Checks', text: 'Which checks run?', multi: true, options: [option('Unit'), option('Lint'), option('E2E')] };
const vote = (userId: string, part: number, choice: number[] | string) => ({ userId, displayName: userId.slice(4), part, at: 1, ...(typeof choice === 'string' ? { other: choice } : { options: choice }) });

function question(parts: Question['parts'], votes: Question['votes'], eligible = 4): Question {
  return questionSchema.parse({ id: 'q_1', sessionId: 's_1', askedAt: 1, status: 'open', parts, votes, comments: [], eligible, decider: null });
}

describe('votes on a question: one tally, one notion of "has voted", one leading answer', () => {
  it('the tally is per part, per option, then "Other", in the shape the answer stores', () => {
    const q = question([single, multi], [vote('dev:amy', 0, [0]), vote('dev:bob', 0, [0]), vote('dev:ian', 0, 'Behind a flag'), vote('dev:amy', 1, [0, 1]), vote('dev:bob', 1, [1])]);
    expect(questionTally(q)).toEqual([
      [2, 0, 0, 1],
      [1, 2, 0, 0],
    ]);
    expect(questionTallySchema.safeParse(questionTally(q)).success).toBe(true);
    expect(questionTally(question([single], []))).toEqual([[0, 0, 0, 0]]);
  });

  it('a member has voted once they voted on EVERY part; a vote on any part makes them count as eligible', () => {
    const q = question([single, multi], [vote('dev:amy', 0, [0]), vote('dev:amy', 1, [2]), vote('dev:bob', 0, [1]), vote('dev:ian', 1, 'none of them')]);
    const voters = votersOf(q);
    expect(voters.byPart).toEqual([['dev:amy', 'dev:bob'], ['dev:amy', 'dev:ian']]);
    expect(voters.any).toEqual(['dev:amy', 'dev:bob', 'dev:ian']);
    expect(voters.complete).toEqual(['dev:amy']);
    expect(allVoted({ ...q, eligible: 3 })).toBe(false);
    expect(allVoted(question([single], [vote('dev:amy', 0, [0]), vote('dev:bob', 0, 'x')], 2))).toBe(true);
    expect(allVoted(question([single], [], 0))).toBe(false); // nobody is eligible: nothing to wait for, nothing voted
  });

  it('single-select: the option with strictly the most votes leads; a tie, a lead of "Other" or no vote gives null', () => {
    expect(leadingAnswer(question([single], [vote('dev:amy', 0, [1]), vote('dev:bob', 0, [1]), vote('dev:ian', 0, [0])]))).toEqual([{ options: [1] }]);
    expect(leadingAnswer(question([single], [vote('dev:amy', 0, [1]), vote('dev:bob', 0, [0])]))).toEqual([null]);
    expect(leadingAnswer(question([single], [vote('dev:amy', 0, [1]), vote('dev:bob', 0, 'x')]))).toEqual([null]);
    expect(leadingAnswer(question([single], [vote('dev:amy', 0, 'x'), vote('dev:bob', 0, 'y'), vote('dev:ian', 0, [2])]))).toEqual([null]);
    expect(leadingAnswer(question([single], []))).toEqual([null]);
  });

  it('multi-select: the options more than half of that part\'s voters chose, in option order', () => {
    const votes = [vote('dev:amy', 0, [2, 0]), vote('dev:bob', 0, [0]), vote('dev:ian', 0, [0, 2]), vote('dev:eve', 0, 'x')];
    expect(leadingAnswer(question([multi], votes))).toEqual([{ options: [0] }]); // Unit 3 of 4; E2E 2 of 4 is not more than half
    expect(leadingAnswer(question([multi], votes.slice(0, 3)))).toEqual([{ options: [0, 2] }]);
    expect(leadingAnswer(question([multi], [vote('dev:amy', 0, [0]), vote('dev:bob', 0, [1])]))).toEqual([null]);
  });

  it('the label an inbox row shows is the first part\'s, and only when exactly one option leads', () => {
    expect(leadingLabel(question([single, multi], [vote('dev:amy', 0, [0]), vote('dev:amy', 1, [1])]))).toBe('On the server');
    expect(leadingLabel(question([single], [vote('dev:amy', 0, [0]), vote('dev:bob', 0, [1])]))).toBeUndefined();
    expect(leadingLabel(question([multi], [vote('dev:amy', 0, [0, 1])]))).toBeUndefined();
    expect(leadingLabel(question([multi], [vote('dev:amy', 0, [1])]))).toBe('Lint');
    expect(leadingLabel(question([single], []))).toBeUndefined();
  });

  it('a leading answer is one `question.submit` would take', () => {
    const q = question([single, multi], [vote('dev:amy', 0, [2]), vote('dev:amy', 1, [0, 1])]);
    expect(leadingAnswer(q)).toEqual([{ options: [2] }, { options: [0, 1] }]);
  });
});
