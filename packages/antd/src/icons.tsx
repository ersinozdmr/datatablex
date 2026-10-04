import type { ReactNode } from "react";

/**
 * `@ant-design/icons` is not a direct dependency of this package; the icons are
 * small inline SVGs that use `currentColor`, so they follow the theme and dark
 * mode and no new dependency is added. This component is the shared SVG
 * wrapper of all icons.
 */
export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      {children}
    </svg>
  );
}

/** Icon for the column management button. */
export const ColumnsIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16M15 4v16" />
  </Icon>
);
/** Download (export) icon. */
export const DownloadIcon = () => (
  <Icon>
    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 20h16" />
  </Icon>
);
/** Icon for the "this page" export scope. */
export const PageIcon = () => (
  <Icon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Icon>
);
/** Filter (funnel) icon. */
export const FilterIcon = () => (
  <Icon>
    <path d="M3 5h18l-7 8v6l-4-2v-4z" />
  </Icon>
);
/** Icon for the "selected rows" export scope. */
export const SelectedIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M8 12l3 3 5-6" />
  </Icon>
);
/** Icon for the CSV export format. */
export const CsvIcon = () => (
  <Icon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </Icon>
);
/** Icon for the Excel export format. */
export const ExcelIcon = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 10h18M3 15h18M9 4v16" />
  </Icon>
);
/** Icon for the PDF export format. */
export const PdfIcon = () => (
  <Icon>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M8 16h8M8 12h5" />
  </Icon>
);
/** Unsorted state icon (both directions). */
export const SortIcon = () => (
  <Icon>
    <path d="M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3" />
  </Icon>
);
/** Ascending sort icon. */
export const SortAscIcon = () => (
  <Icon>
    <path d="M12 19V5m0 0l-5 5m5-5l5 5" />
  </Icon>
);
/** Descending sort icon. */
export const SortDescIcon = () => (
  <Icon>
    <path d="M12 5v14m0 0l-5-5m5 5l5-5" />
  </Icon>
);
/** Close (remove) icon. */
export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
/** Text wrapping icon. */
export const WrapIcon = () => (
  <Icon>
    <path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4m0 0l2-2m-2 2l2 2M4 18h5" />
  </Icon>
);
/** Right-pointing chevron icon. */
export const ChevronRightIcon = () => (
  <Icon>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);
/** Duplicate icon. */
export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </Icon>
);
/** More actions (three dots) icon. */
export const MoreIcon = () => (
  <Icon>
    <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
  </Icon>
);
/** Lock icon for locked filters. */
export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);
