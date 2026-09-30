// Inline SVG icons (16 × 16 grid, 1.5 px strokes, currentColor). Decorative by default (aria-hidden); an icon that
// carries meaning on its own gets a `title`, or sits in an IconButton whose label names the action.
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Pixel size (default 16). */
  size?: number;
  /** Accessible name; without it the icon is hidden from assistive technology. */
  title?: string;
}

function Svg({ size = 16, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export type IconComponent = (props: IconProps) => ReactNode;

export const IconFolder: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h5.6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </Svg>
);
export const IconFolderOpen: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M1.75 12.25V4.25a1 1 0 0 1 1-1h3.4l1.5 1.5h4.6a1 1 0 0 1 1 1v1" />
    <path d="M1.75 12.25l1.6-4.8a1 1 0 0 1 .95-.7h9.65a.75.75 0 0 1 .7 1l-1.5 4.5H1.75z" />
  </Svg>
);
export const IconFile: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
    <path d="M9.25 1.75v3h3" />
  </Svg>
);
export const IconFileText: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
    <path d="M9.25 1.75v3h3M5.75 8.25h4.5M5.75 10.75h4.5" />
  </Svg>
);
export const IconChevronRight: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
);
export const IconChevronDown: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Svg>
);
export const IconChevronUp: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.5 10 8 5.5 12.5 10" />
  </Svg>
);
export const IconChevronLeft: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M10 3.5 5.5 8 10 12.5" />
  </Svg>
);
export const IconClose: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const IconPlus: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconMinus: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3 8h10" />
  </Svg>
);
export const IconTerminal: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
    <path d="M4.5 6.25 6.75 8.5 4.5 10.75M8.5 10.75h3" />
  </Svg>
);
/** An agent: a rounded head with an antenna (never an emoji). */
export const IconAgent: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="2.75" y="5.25" width="10.5" height="8" rx="2" />
    <path d="M8 2.25v3M6 9.25v.01M10 9.25v.01M6.25 11.5h3.5" />
  </Svg>
);
export const IconUser: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="5.25" r="2.75" />
    <path d="M2.75 14c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4" />
  </Svg>
);
export const IconUsers: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="6" cy="5.5" r="2.25" />
    <path d="M1.75 13.5c.5-2.2 2.1-3.4 4.25-3.4s3.75 1.2 4.25 3.4" />
    <path d="M10.5 3.5a2.25 2.25 0 0 1 0 4.25M11.5 10.2c1.4.4 2.4 1.5 2.75 3.3" />
  </Svg>
);
export const IconLightbulb: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5.75 11.25c0-1.2-2-2.4-2-5a4.25 4.25 0 0 1 8.5 0c0 2.6-2 3.8-2 5z" />
    <path d="M6.25 13.75h3.5" />
  </Svg>
);
export const IconActivity: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M1.75 8h2.5l1.75-4.5 3 9 1.75-4.5h3.5" />
  </Svg>
);
export const IconAlertTriangle: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.4 9.5a1 1 0 0 1-.87 1.5H2.6a1 1 0 0 1-.87-1.5z" />
    <path d="M8 6.25v3M8 11.25v.01" />
  </Svg>
);
export const IconAlertCircle: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.75v3.75M8 11.25v.01" />
  </Svg>
);
export const IconInfo: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.75v.01" />
  </Svg>
);
export const IconCheck: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3 8.5 6.25 11.75 13 4.75" />
  </Svg>
);
export const IconLock: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.25" />
    <path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2" />
  </Svg>
);
export const IconUnlock: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.25" />
    <path d="M5.25 7V5a2.75 2.75 0 0 1 5.3-1" />
  </Svg>
);
export const IconUpload: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 10.5V2.75M4.75 6 8 2.75 11.25 6M2.75 10.75v1.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1.5" />
  </Svg>
);
export const IconDownload: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 2.75v7.75M4.75 7.25 8 10.5l3.25-3.25M2.75 10.75v1.5a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1.5" />
  </Svg>
);
export const IconGitBranch: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2.5-7 4.5" />
  </Svg>
);
export const IconGitMerge: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="10.5" r="1.5" />
    <path d="M4.5 5v6M4.5 5c0 3 3 5.5 5.5 5.5" />
  </Svg>
);
export const IconSettings: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.25" />
    <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
  </Svg>
);
export const IconLogOut: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6.25 13.25h-3a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1h3M10.5 11 13.5 8l-3-3M13.25 8H6.5" />
  </Svg>
);
export const IconRefresh: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M13.25 7.5a5.25 5.25 0 0 0-9.6-2.5M2.75 8.5a5.25 5.25 0 0 0 9.6 2.5" />
    <path d="M3.25 2.25v2.75H6M12.75 13.75V11H10" />
  </Svg>
);
export const IconShield: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 1.75 13.25 3.5v4c0 3.2-2.2 5.6-5.25 6.75C4.95 13.1 2.75 10.7 2.75 7.5v-4z" />
  </Svg>
);
export const IconShieldAlert: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M8 1.75 13.25 3.5v4c0 3.2-2.2 5.6-5.25 6.75C4.95 13.1 2.75 10.7 2.75 7.5v-4z" />
    <path d="M8 5.25v3M8 10.5v.01" />
  </Svg>
);
export const IconKey: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="5" cy="10.5" r="2.75" />
    <path d="M7 8.5 13.25 2.25M10.75 4.75l1.75 1.75M9.25 6.25l1.25 1.25" />
  </Svg>
);
export const IconSearch: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25 13.5 13.5" />
  </Svg>
);
export const IconMore: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.25} />
  </Svg>
);
export const IconPanelBottom: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
    <path d="M1.75 9.75h12.5" />
  </Svg>
);
export const IconPanelRight: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
    <path d="M9.75 2.75v10.5" />
  </Svg>
);
export const IconMaximize: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M9.75 2.75h3.5v3.5M13.25 2.75 9 7M6.25 13.25h-3.5v-3.5M2.75 13.25 7 9" />
  </Svg>
);
export const IconMinimize: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M13.25 2.75 9.5 6.5M9.5 3.5v3h3M2.75 13.25 6.5 9.5M6.5 12.5v-3h-3" />
  </Svg>
);
export const IconPanelLeft: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
    <path d="M6.25 2.75v10.5" />
  </Svg>
);
export const IconSun: IconComponent = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </Svg>
);
export const IconMoon: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z" />
  </Svg>
);
export const IconMonitor: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.25" width="12.5" height="8.5" rx="1" />
    <path d="M5.5 13.75h5M8 10.75v3" />
  </Svg>
);
export const IconCopy: IconComponent = (p) => (
  <Svg {...p}>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1" />
    <path d="M10.75 5.25v-2a1 1 0 0 0-1-1h-6.5a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h2" />
  </Svg>
);
export const IconExternalLink: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11.25 9.5v3a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1h3" />
  </Svg>
);
export const IconLink: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6.75 9.25a2.75 2.75 0 0 0 3.9.15l2-2a2.75 2.75 0 0 0-3.9-3.9l-.6.6" />
    <path d="M9.25 6.75a2.75 2.75 0 0 0-3.9-.15l-2 2a2.75 2.75 0 0 0 3.9 3.9l.6-.6" />
  </Svg>
);
export const IconCloudOff: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M5 5.4A3.75 3.75 0 0 0 4.25 12.5h7.5M10.1 4.1A3.75 3.75 0 0 1 13.4 9M2 2l12 12" />
  </Svg>
);
export const IconPlugOff: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M6 2v3M10 2v3M4.25 5h7.5v2.75A3.75 3.75 0 0 1 8 11.5v2.75M2 2l12 12" />
  </Svg>
);
export const IconTrash: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4 4.25l.6 9h6.8l.6-9M6.75 7v3.75M9.25 7v3.75" />
  </Svg>
);
export const IconEdit: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M10.5 2.75 13.25 5.5 5.75 13H3v-2.75z" />
  </Svg>
);
export const IconEye: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M1.5 8S3.75 3.5 8 3.5 14.5 8 14.5 8 12.25 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.9" />
  </Svg>
);
export const IconSend: IconComponent = (p) => (
  <Svg {...p}>
    <path d="M14 2 7.25 8.75M14 2 9.75 14l-2.5-5.25L2 6.25z" />
  </Svg>
);
