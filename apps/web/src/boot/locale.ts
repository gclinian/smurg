// SECOND import of main.tsx (right after capture-invite, before the string catalogue and every component): resolves
// the language of this browser (stored choice > cookie `smurg_lang` > navigator.languages > English) and sets
// <html lang>, so the first render is already in the right language and Han glyphs are picked for the right script.
import { initLocale } from '../lib/locale.ts';

export const bootLocale = initLocale();
