// The few words the Markdown renderer adds to what people and agents wrote (which is never translated).
import { defineStrings } from '../../strings/catalog.ts';
import { zhTW } from './strings.zh-TW.ts';

export const t = defineStrings(
  'markdown',
  {
    'link.newTab': '{address} (opens in a new tab)',
    'image.link': 'Image: {alt}',
    'image.noAlt': 'Image',
    'image.notLoaded': 'Images are not loaded here. This link opens the image in a new tab.',
    'path.open': 'Open {path}',
    // A wiki link of a sticky note (DESIGN 0.8.0 D7.5); after a link to a note that is not written yet, for a reader
    // who does not see the link's other look.
    'wiki.open': 'Open the sticky note {name}',
    'wiki.missing': '(not written yet)',
    'task.done': 'Done',
    'task.open': 'Not done',
    'code.label': 'Code',
    'code.labelLang': 'Code ({lang})',
    'plain.note': 'Shown as it was written: this text is too long or too deeply nested to format.',
  },
  zhTW,
);
