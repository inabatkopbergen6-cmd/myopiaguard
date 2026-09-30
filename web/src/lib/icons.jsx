/**
 * Inline icon set — a handful of 1.6px-stroke SVGs so the app has no icon
 * dependency and every glyph inherits `currentColor` (which is what lets the
 * status colours carry meaning on their own).
 */
const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

const Icon = ({ children, size = 16, ...rest }) => (
  <svg {...base} width={size} height={size} {...rest}>
    {children}
  </svg>
);

export const EyeIcon = (props) => (
  <Icon {...props}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3.2" />
  </Icon>
);

export const ShieldIcon = (props) => (
  <Icon {...props}>
    <path d="M12 3.5 5 6.2v5.4c0 4 2.9 7.4 7 8.9 4.1-1.5 7-4.9 7-8.9V6.2Z" />
    <path d="m9.2 12.2 2 2 3.6-4" />
  </Icon>
);

export const MonitorIcon = (props) => (
  <Icon {...props}>
    <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <path d="M8 20.5h8M12 16.5v4" />
  </Icon>
);

export const BellIcon = (props) => (
  <Icon {...props}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
    <path d="M10.3 20a2 2 0 0 0 3.4 0" />
  </Icon>
);

export const MegaphoneIcon = (props) => (
  <Icon {...props}>
    <path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z" />
    <path d="M14 8.5a4 4 0 0 1 0 7M17 6a7.5 7.5 0 0 1 0 12" />
  </Icon>
);

export const GlobeIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" />
  </Icon>
);

export const GridIcon = (props) => (
  <Icon {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Icon>
);

export const ListIcon = (props) => (
  <Icon {...props}>
    <path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01" />
  </Icon>
);

export const PlayIcon = (props) => (
  <Icon {...props}>
    <path d="M7 4.8 19 12 7 19.2Z" />
  </Icon>
);

export const StopIcon = (props) => (
  <Icon {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
);

export const XIcon = (props) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const AlertIcon = (props) => (
  <Icon {...props}>
    <path d="M12 4.5 2.8 19.5h18.4Z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
);

export const ClockIcon = (props) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const CheckIcon = (props) => (
  <Icon {...props}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Icon>
);

export const DownloadIcon = (props) => (
  <Icon {...props}>
    <path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15" />
  </Icon>
);

export const PrintIcon = (props) => (
  <Icon {...props}>
    <path d="M7 9V4.5h10V9" />
    <rect x="4" y="9" width="16" height="7" rx="2" />
    <path d="M7 14h10v5.5H7Z" />
  </Icon>
);

export const RefreshIcon = (props) => (
  <Icon {...props}>
    <path d="M20 11.5a8 8 0 1 0-2.6 6.3" />
    <path d="M20 4.5v7h-7" />
  </Icon>
);

export const UsersIcon = (props) => (
  <Icon {...props}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.5 14c2 .6 3.5 2.3 3.5 5" />
  </Icon>
);

export const SlidersIcon = (props) => (
  <Icon {...props}>
    <path d="M5 7h14M5 12h14M5 17h14" />
    <circle cx="9" cy="7" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="11" cy="17" r="2" />
  </Icon>
);

export const ChartIcon = (props) => (
  <Icon {...props}>
    <path d="M4 19.5V4.5M4 19.5h16" />
    <path d="M8 16v-5M12.5 16V7.5M17 16v-3" />
  </Icon>
);

export const DocIcon = (props) => (
  <Icon {...props}>
    <path d="M6.5 3.5h7L18 8v12.5H6.5Z" />
    <path d="M13 3.5V8h5M9.5 12.5h5M9.5 16h5" />
  </Icon>
);

export const SparkIcon = (props) => (
  <Icon {...props}>
    <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.5 6.5l2 2M15.5 15.5l2 2M17.5 6.5l-2 2M8.5 15.5l-2 2" />
    <circle cx="12" cy="12" r="2.6" />
  </Icon>
);

export const ChevronIcon = (props) => (
  <Icon {...props}>
    <path d="m8 10 4 4 4-4" />
  </Icon>
);

export default {
  EyeIcon,
  ShieldIcon,
  MonitorIcon,
  BellIcon,
  MegaphoneIcon,
  GlobeIcon,
  GridIcon,
  ListIcon,
  PlayIcon,
  StopIcon,
  XIcon,
  AlertIcon,
  ClockIcon,
  CheckIcon,
  DownloadIcon,
  PrintIcon,
  RefreshIcon,
  UsersIcon,
  SlidersIcon,
  ChartIcon,
  DocIcon,
  SparkIcon,
  ChevronIcon,
};
