// The words of the sticky notes (DESIGN 0.8.0 D7): the list of notes, the open note, the pages without a note, the
// feedback under a note. A note's name is a file's name, written by a person: it is never translated, `Home` neither
// (D1.1). Feedback's words are the suggestion's (docs/GLOSSARY.md): Accept / Reject, Withdraw.
import { defineStrings } from '../../strings/catalog.ts';
import { zhTW } from './strings.zh-TW.ts';

export const t = defineStrings(
  'sticky',
  {
    // The list of notes on the left (D7.4).
    'tree.label': 'Sticky notes from Home',
    'tree.notLinked': 'Not linked',
    'tree.notLinked.hint': 'No sticky note links to these from Home.',
    'tree.empty': 'No sticky notes yet.',
    'tree.truncated': 'Only the first {max} sticky notes are listed.',
    'row.unreadable': '{name}, cannot be read',
    'row.shadowed': '{name}, not read: {note} has the same name',
    'row.shadowed.mark': 'same name as {note}',
    // A row's name with the feedback that waits on its note, for a member who can decide (D7.8).
    'row.waiting': { one: '{name}, {count} piece of feedback waiting', other: '{name}, {count} pieces of feedback waiting' },
    // The group of names with waiting feedback that the index does not hold, for a member who can decide (D7.4).
    'tree.gone': 'Feedback on sticky notes that are gone',
    'tree.gone.hint': 'No sticky note has these names now, and feedback on them still waits.',
    'loading': 'Loading the sticky notes…',
    'load.failed': 'The sticky notes could not be loaded: {reason}',
    'load.retry': 'Try again',
    // The open note (D7.5).
    'note.loading': 'Opening the sticky note…',
    'note.empty': 'This sticky note is empty.',
    'note.agentWriting': 'Claude is writing this sticky note.',
    // Only what is true of every note the index could not read (a file kept from members, one nobody may read, one
    // whose first read failed for a moment, a link, bytes that are not text): no cause is named.
    'note.unreadable': 'smurg could not read the file of this sticky note.',
    'note.openFailed': 'This sticky note could not be opened.',
    'note.oversized': 'This sticky note is larger than 64 KiB: the list on the left does not follow its links.',
    // What a member does with the open note (D7.5, D7.7): read it or edit it together, add a note linked from it, ask
    // Claude for the sticky notes about it.
    'note.actions': 'What to do with this sticky note',
    'note.view': 'How the sticky note is shown',
    'note.read': 'Read',
    'note.edit': 'Edit',
    'note.ask': 'Ask Claude about this sticky note',
    'add.title': 'Add a sticky note',
    'add.body': 'A new, empty sticky note. Its link goes at the end of {note}.',
    'add.name': 'Name of the new sticky note',
    'add.confirm': 'Add',
    'add.done': '{name} is linked at the end of {note}.',
    'add.readOnly': 'The link to {name} was not added: {note} cannot be changed right now.',
    // Said after add.readOnly only when the list really has the new note under "Not linked" (review S4-R4): a note
    // another one already linked to is under that one, and one that was there may be anywhere.
    'add.notLinked': '{name} is under "Not linked" until a sticky note links to it.',
    // The pages without a note (D7.6).
    'first.title': 'Start with one sticky note',
    'first.body': 'Every sticky note grows from the first one, Home: a sticky note links to the next with [[Name]].',
    'first.write': 'Write the first sticky note',
    'first.viewer': 'There is no sticky note yet. A member who can edit writes the first one.',
    'missing.body': 'This sticky note is not written yet.',
    'missing.write': 'Write this sticky note',
    'missing.viewer': 'A member who can edit can write it.',
    'create.failed': 'The sticky note was not written: {reason}',
    // Feedback under the note (D7.8). Everyone gives it; a member with agent access accepts or rejects it.
    'feedback.title': 'Feedback',
    'feedback.box': 'Give feedback on {note}',
    'feedback.hint': 'Everyone in the workspace sees it. It reaches Claude only when a member with agent access accepts it.',
    'feedback.give': 'Give feedback',
    'feedback.failed': 'Your feedback was not given: {reason}',
    'feedback.loading': 'Loading the feedback…',
    'feedback.loadFailed': 'The feedback could not be loaded: {reason}',
    // Where an outside author wrote (D6), beside their name: never a member, never an avatar.
    'feedback.source.slack': 'from Slack',
    'feedback.source.discord': 'from Discord',
    'feedback.cleaned': 'Hidden characters were removed.',
    'feedback.cut': 'The message was longer: only its start is kept.',
    'feedback.accept': 'Accept',
    'feedback.reject': 'Reject',
    'feedback.reject.label': 'Why? (optional; everyone sees it)',
    'feedback.reject.confirm': 'Reject',
    'feedback.withdraw': 'Withdraw',
    // Before Accept: the exact message the daemon sends (composeFeedback of @smurg/protocol), as plain text.
    'feedback.preview': 'What Claude gets',
    'feedback.preview.hint': 'Accept sends this once to Claude for the sticky notes, as your message.',
    'feedback.accepted': 'Accepted by {name}, {time}',
    'feedback.rejected': 'Rejected by {name}, {time}',
    'feedback.rejectedWith': 'Rejected by {name}, {time}: "{reason}"',
    'feedback.earlier': 'Show {count} earlier',
    // Accept refused because Claude for the sticky notes is not running (no-assistant): start it, then accept again.
    'feedback.start': 'Start Claude',
    'feedback.startFailed': 'Claude was not started: {reason}',
  },
  zhTW,
);
