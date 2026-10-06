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
    'task.done': 'Done',
    'task.open': 'Not done',
    'code.label': 'Code',
    'code.labelLang': 'Code ({lang})',
  },
  zhTW,
);
