import { useStore } from '../lib/store.ts';
import type { ThemePreference } from '../lib/preferences.ts';
import { tApp } from '../strings/app.ts';
import { Menu } from '../ui/index.ts';
import { IconMonitor, IconMoon, IconSun } from '../ui/icons.tsx';
import { useAppServices } from './services.tsx';

const ICONS = { system: <IconMonitor />, dark: <IconMoon />, light: <IconSun /> } as const;

/** Theme picker: follow the OS, dark, or light. */
export function ThemeMenu() {
  const { theme } = useAppServices();
  const { preference, resolved } = useStore(theme);
  const option = (value: ThemePreference) => ({
    id: value,
    label: tApp(`theme.${value}`),
    icon: ICONS[value],
    checked: preference === value,
    onSelect: () => theme.setPreference(value),
  });
  return <Menu label={tApp('theme.label')} icon={resolved === 'dark' ? <IconMoon /> : <IconSun />} items={[option('system'), option('dark'), option('light')]} />;
}
