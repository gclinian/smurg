import { LOCALES, intlTag } from '@smurg/protocol/locale';
import { LOCALE_NAMES, localeStore, setLocale } from '../lib/locale.ts';
import { useStore } from '../lib/store.ts';
import { tUi } from '../strings/ui.ts';
import { IconCheck, IconGlobe } from './icons.tsx';
import { Menu } from './Menu.tsx';

export interface LanguageMenuProps {
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The language switch: a globe button on every screen (landing, join, login, the connection screens, not found, the
 * top bar). Each language is named in itself ("English", the Traditional Chinese label) and carries its own `lang`,
 * so a person who cannot read the current language still finds theirs. The choice is remembered in this browser and
 * mirrored into the `smurg_lang` cookie for the relay's pages (lib/locale.ts); nothing reloads.
 */
export function LanguageMenu({ size = 'md', className }: LanguageMenuProps) {
  const locale = useStore(localeStore);
  return (
    <Menu
      label={tUi('language.label')}
      icon={<IconGlobe />}
      size={size}
      className={className}
      testId="language-menu"
      items={LOCALES.map((id) => ({
        id,
        label: LOCALE_NAMES[id],
        lang: intlTag(id),
        icon: locale === id ? <IconCheck /> : undefined,
        checked: locale === id,
        onSelect: () => setLocale(id),
      }))}
    />
  );
}
