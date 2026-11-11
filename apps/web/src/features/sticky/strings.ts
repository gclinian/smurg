// The words of the sticky notes (DESIGN 0.8.0 D7): the list of notes, the open note, the pages without a note. A
// note's name is a file's name, written by a person: it is never translated, `Home` neither (D1.1).
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
    'add.readOnly': 'The link to {name} was not added: {note} cannot be changed right now. {name} is under "Not linked" until a sticky note links to it.',
    // The pages without a note (D7.6).
    'first.title': 'Start with one sticky note',
    'first.body': 'Every sticky note grows from the first one, Home: a sticky note links to the next with [[Name]].',
    'first.write': 'Write the first sticky note',
    'first.viewer': 'There is no sticky note yet. A member who can edit writes the first one.',
    'missing.body': 'This sticky note is not written yet.',
    'missing.write': 'Write this sticky note',
    'missing.viewer': 'A member who can edit can write it.',
    'create.failed': 'The sticky note was not written: {reason}',
  },
  zhTW,
);
