import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Button, Divider, Popover, Space, Typography, theme } from "antd";
import type { Density, ReactDataTableColumn } from "@datatablex/react";
import { cellPadding } from "./density.js";
import { ChevronRightIcon, CloseIcon, FilterIcon, SortAscIcon, SortDescIcon, SortIcon, WrapIcon } from "./icons.js";
import { enUS, useDataTableLocale } from "./locale.js";
import type { DataTableLocale } from "./locale.js";
import { columnLabel } from "./ruleEditor.js";

/** Sort direction of a column in the header menu: `undefined` means the column is not sorted. */
export type SortDirection = "ascend" | "descend" | undefined;

/** Props of {@link ColumnHeaderMenu}. */
export interface ColumnHeaderMenuProps<T> {
  /** The column this menu belongs to; its `type` decides the sort labels and its label names the menu for assistive technology. */
  column: ReactDataTableColumn<T>;
  /** Header content rendered inside the trigger button. */
  title: ReactNode;
  /** Whether the "Sort" row is offered in the menu. */
  sortable: boolean;
  /** Current sort direction of the column; shown as an arrow on the trigger and as the checked option in the sort panel. */
  sortDirection: SortDirection;
  /** Whether the cell content wraps onto multiple lines. It applies to every column, independent of sorting and filtering. */
  wrap: boolean;
  /** Density of the table. The padding is taken from the `<th>` (see `cellPadding` in `density.ts`) and re-applied here so the trigger looks consistent at every size. */
  density: Density;
  /** Called with the chosen direction, or `undefined` when the sort is removed. */
  onSortChange: (direction: SortDirection) => void;
  /** Called when the user toggles content wrapping for the column. */
  onWrapToggle: () => void;
  /**
   * When provided, the menu shows a "Filter" row: it closes the menu and opens
   * the rule editor for this column's field in the filter bar. The filter bar
   * is the only filter interface; the header menu has no filter box of its own.
   */
  onFilterShortcut?: () => void;
}

type SubmenuView = "sort";
type MenuView = "menu" | SubmenuView;

const ROW_STYLE: CSSProperties = { justifyContent: "flex-start", display: "flex", alignItems: "center" };

const MENU_ITEM_SELECTOR = "[role^='menuitem']:not([disabled])";

/**
 * Labels of the sort directions by column TYPE. "A → Z" only makes sense for
 * text; on number and date columns it would give the user a wrong mental model.
 */
export function sortLabelsFor<T>(column: ReactDataTableColumn<T>, locale: DataTableLocale = enUS): { asc: string; desc: string } {
  switch (column.type) {
    case "number":
    case "currency":
      return { asc: locale.sortNumberAsc, desc: locale.sortNumberDesc };
    case "date":
    case "datetime":
    case "time":
      return { asc: locale.sortDateAsc, desc: locale.sortDateDesc };
    default:
      return { asc: locale.sortTextAsc, desc: locale.sortTextDesc };
  }
}

/** A row of the main menu: icon plus text; a row that opens a submenu also shows a direction arrow on the right. */
function MenuRow({
  icon,
  label,
  submenu,
  expanded,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** The submenu this row opens. It can also be opened with the right arrow key, and focus returns to this row when the submenu closes. */
  submenu?: SubmenuView;
  expanded?: boolean;
  onClick: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <Button
      type="text"
      block
      role="menuitem"
      icon={icon}
      aria-haspopup={submenu ? "true" : undefined}
      aria-expanded={submenu ? Boolean(expanded) : undefined}
      data-submenu={submenu}
      style={{ ...ROW_STYLE, background: expanded ? token.controlItemBgActive : undefined }}
      onClick={onClick}
    >
      <span style={{ flex: 1, textAlign: "start" }}>{label}</span>
      {submenu ? <ChevronRightIcon /> : null}
    </Button>
  );
}

/** Title of the submenu on the right. It is not interactive; going back is done with the left arrow, Escape or the row in the main menu. */
function SubmenuTitle({ label }: { label: string }) {
  return (
    <Typography.Text strong style={{ display: "block", padding: "5px 15px" }}>
      {label}
    </Typography.Text>
  );
}

/**
 * Moves focus to the next or previous menu item inside `container`, wrapping
 * around at the ends. It is only called while a menu item has focus: in inputs
 * the arrow keys control the caret and the number step.
 */
function moveFocus(container: HTMLElement, from: HTMLElement, step: 1 | -1) {
  const items = Array.from(container.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
  if (!items.length) return;
  const index = items.indexOf(from);
  items[(index + step + items.length) % items.length]?.focus();
}

/**
 * Column header menu: the main menu lists, with icons, "Filter" and "Sort"
 * (when applicable) and the wrap/unwrap content row, which applies to EVERY
 * column. "Sort" opens a submenu to the right of the main menu WITHOUT closing
 * it; "Filter" opens the rule editor for that field in the filter bar; the wrap
 * row is an immediate action. The submenu opens on click and stays open until
 * another row is chosen, or until the left arrow or Escape is pressed, so it
 * does not close while the pointer moves between the two panels.
 *
 * Keyboard: up/down moves within a panel, right opens the submenu, left and
 * Escape return from the submenu to the row that opened it; in the main menu
 * Escape closes the menu.
 */
export function ColumnHeaderMenu<T>({
  column,
  title,
  sortable,
  sortDirection,
  wrap,
  density,
  onSortChange,
  onWrapToggle,
  onFilterShortcut,
}: ColumnHeaderMenuProps<T>) {
  const { token } = theme.useToken();
  const locale = useDataTableLocale();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [view, setView] = useState<MenuView>("menu");
  const handleOpenChange = useCallback(
    (next: boolean) => {
      // The popover always reopens on the main menu, so a previous submenu does not leak into it.
      if (next) setView("menu");
      setOpen(next);
    },
    [],
  );

  const applySort = useCallback(
    (direction: SortDirection) => {
      onSortChange(direction);
      setOpen(false);
    },
    [onSortChange],
  );

  const toggleWrap = useCallback(() => {
    onWrapToggle();
    setOpen(false);
  }, [onWrapToggle]);

  /** Clicking the row of the open submenu again closes the submenu. */
  const toggleSubmenu = (next: SubmenuView) => setView((current) => (current === next ? "menu" : next));

  // When a submenu opens, focus moves to its first item; when it closes, focus
  // returns to the row that opened it. Otherwise, once the clicked item leaves
  // the DOM, focus falls to `<body>` and neither arrow/Tab navigation nor
  // Escape reaches the panel.
  const panelRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const lastSubmenuRef = useRef<SubmenuView | null>(null);
  useEffect(() => {
    if (!open) {
      lastSubmenuRef.current = null;
      return;
    }
    const id = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      let target: HTMLElement | null = null;
      if (view !== "menu") {
        lastSubmenuRef.current = view;
        const submenu = submenuRef.current;
        target = submenu?.querySelector<HTMLElement>(`${MENU_ITEM_SELECTOR}, button`) ?? null;
      } else if (lastSubmenuRef.current) {
        target = panel.querySelector<HTMLElement>(`[data-submenu='${lastSubmenuRef.current}']`);
        lastSubmenuRef.current = null;
      }
      (target ?? panel.querySelector<HTMLElement>(MENU_ITEM_SELECTOR))?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, view]);

  // Escape closes the submenu first, then the menu itself. The arrow keys are
  // only handled while a menu item has focus.
  const handleKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      if (view !== "menu") setView("menu");
      else setOpen(false);
      return;
    }
    if (!target.matches(MENU_ITEM_SELECTOR)) return;
    const inSubmenu = Boolean(submenuRef.current?.contains(target));
    const container = target.closest<HTMLElement>("[role='menu']");
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && container) {
      e.preventDefault();
      moveFocus(container, target, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "ArrowRight" && !inSubmenu && target.dataset.submenu) {
      e.preventDefault();
      setView(target.dataset.submenu as SubmenuView);
    } else if (e.key === "ArrowLeft" && inSubmenu) {
      e.preventDefault();
      setView("menu");
    }
  };

  const sortLabels = sortLabelsFor(column, locale);

  const sortPanel = (
    <>
      <SubmenuTitle label={locale.sort} />
      <Divider style={{ margin: "4px 0" }} />
      <Space direction="vertical" style={{ width: "100%" }} size={0}>
        <Button
          type="text"
          block
          role="menuitemradio"
          icon={<SortAscIcon />}
          aria-checked={sortDirection === "ascend"}
          style={ROW_STYLE}
          onClick={() => applySort("ascend")}
        >
          {sortDirection === "ascend" ? "✓ " : ""}
          {locale.sortOption(sortLabels.asc)}
        </Button>
        <Button
          type="text"
          block
          role="menuitemradio"
          icon={<SortDescIcon />}
          aria-checked={sortDirection === "descend"}
          style={ROW_STYLE}
          onClick={() => applySort("descend")}
        >
          {sortDirection === "descend" ? "✓ " : ""}
          {locale.sortOption(sortLabels.desc)}
        </Button>
        {sortDirection ? (
          <Button type="text" block role="menuitem" icon={<CloseIcon />} style={ROW_STYLE} onClick={() => applySort(undefined)}>
            {locale.removeSort}
          </Button>
        ) : null}
      </Space>
    </>
  );

  const menuPanel = (
    <Space direction="vertical" style={{ width: "100%" }} size={0}>
      {onFilterShortcut ? (
        <MenuRow
          icon={<FilterIcon />}
          label={locale.filter}
          onClick={() => {
            setOpen(false);
            onFilterShortcut();
          }}
        />
      ) : null}
      {sortable ? (
        <MenuRow icon={<SortIcon />} label={locale.sort} submenu="sort" expanded={view === "sort"} onClick={() => toggleSubmenu("sort")} />
      ) : null}
      <MenuRow icon={<WrapIcon />} label={wrap ? locale.unwrapContent : locale.wrapContent} onClick={toggleWrap} />
    </Space>
  );

  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={handleOpenChange}
      placement="bottomLeft"
      content={
        <div
          ref={panelRef}
          style={{ display: "flex", alignItems: "stretch" }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          <div role="menu" aria-label={locale.columnMenu(columnLabel(column))} style={{ minWidth: 200 }}>
            {menuPanel}
          </div>
          {view !== "menu" ? (
            <div
              ref={submenuRef}
              role="menu"
              aria-label={locale.sort}
              style={{ minWidth: 220, marginInlineStart: 4, paddingInlineStart: 4, borderInlineStart: `1px solid ${token.colorSplit}` }}
            >
              {sortPanel}
            </div>
          ) : null}
        </div>
      }
    >
      <button
        type="button"
        data-testid={`column-header-trigger-${column.key}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          // Same background tone as the row hover (`token.controlItemBgHover`).
          // The click target (button `width`/`height: 100%`) covers the whole
          // cell, not only the header text. The `<th>`'s own padding is reduced
          // to 0 through `onHeaderCell` (see `DataTable.tsx`); the padding is
          // moved onto the button here with `cellPadding`, so `width`/`height:
          // 100%` also covers the area the padding occupies. Because `th` does
          // not carry `position: relative`, in-flow `100%` sizing is used
          // instead of `absolute`.
          background: hovered || open ? token.controlItemBgHover : "transparent",
          border: "none",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding: cellPadding(token, density),
          // The `<th>` cell is `overflow: visible` for the resize handle (see
          // `ResizableTitle`), so header text that overflows in `ellipsis`
          // columns is clipped here.
          overflow: "hidden",
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
          transition: "background-color 0.15s",
        }}
      >
        {title}
        {sortDirection ? <span aria-hidden="true">{sortDirection === "ascend" ? "↑" : "↓"}</span> : null}
      </button>
    </Popover>
  );
}
