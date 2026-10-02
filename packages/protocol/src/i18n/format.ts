// Number formatting shared by both locales of the wire catalog (sizes travel as plain numbers).

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Bytes for people: `5.00 GiB`, `812 B`. Negative values keep their sign (free space after an upload can be negative). */
export function formatBytes(bytes: number): string {
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${bytes < 0 ? '-' : ''}${unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${UNITS[unit]}`;
}
