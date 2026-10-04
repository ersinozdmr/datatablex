import { useState } from "react";
import type { ReactNode } from "react";
import { Button, Popover, Segmented, Space, Typography } from "antd";
import type { ExportDefinition } from "@datatablex/core";
import type { ExportFormat, ExportScope } from "@datatablex/react";
import { useDataTableLocale } from "./locale.js";
import type { DataTableLocale } from "./locale.js";
import { CsvIcon, DownloadIcon, ExcelIcon, FilterIcon, PageIcon, PdfIcon, SelectedIcon } from "./icons.js";

const SCOPES: Record<ExportScope, { label: (locale: DataTableLocale) => string; icon: ReactNode }> = {
  currentPage: { label: (locale) => locale.scopeCurrentPage, icon: <PageIcon /> },
  allFiltered: { label: (locale) => locale.scopeAllFiltered, icon: <FilterIcon /> },
  selected: { label: (locale) => locale.scopeSelected, icon: <SelectedIcon /> },
};

const FORMATS: Record<ExportFormat, { label: string; icon: ReactNode }> = {
  csv: { label: "CSV", icon: <CsvIcon /> },
  excel: { label: "Excel", icon: <ExcelIcon /> },
  pdf: { label: "PDF", icon: <PdfIcon /> },
};

/** Props of {@link ExportMenu}. */
export interface ExportMenuProps {
  /** The export definition: which scopes and formats are offered. */
  definition: ExportDefinition;
  /** Number of selected rows; the "selected" scope is disabled while it is 0 and shows the count otherwise. */
  selectedCount: number;
  /** Whether an export is running; disables the format buttons and puts the trigger in its loading state. */
  isExporting: boolean;
  /** Progress of the running export, shown on the trigger; `null` when there is no progress to show. */
  progress: { current: number; total: number } | null;
  /** Called with the chosen format and scope when the user picks a format. */
  onExport: (format: ExportFormat, scope: ExportScope) => void;
  /** While the table is loading, the formats are disabled for the current-page scope (the data on screen may belong to the previous query). */
  loading?: boolean;
  /** When provided, a cancel button appears next to the trigger while an export is running. */
  onCancel?: () => void;
  /** The `rowKey` differs from the backend `primaryKey`: the "selected" scope is disabled and the reason is shown. */
  selectionBlocked?: boolean;
}

/** Export menu: the scope is chosen first (current page, all filtered, selected), then the format. */
export function ExportMenu({ definition, selectedCount, isExporting, progress, onExport, loading = false, onCancel, selectionBlocked = false }: ExportMenuProps) {
  const locale = useDataTableLocale();
  const [open, setOpen] = useState(false);
  const [chosenScope, setChosenScope] = useState<ExportScope>(definition.scopes[0] ?? "allFiltered");

  const isScopeDisabled = (scope: ExportScope) => scope === "selected" && (selectedCount === 0 || selectionBlocked);
  // If the selection became empty, `selected` cannot stay chosen; fall back to the first usable scope.
  const scope = isScopeDisabled(chosenScope)
    ? (definition.scopes.find((candidate) => !isScopeDisabled(candidate)) ?? chosenScope)
    : chosenScope;

  const waitForLoad = scope === "currentPage" && loading;

  const panel = (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 180 }}>
      {definition.scopes.length > 1 ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {locale.exportScope}
          </Typography.Text>
          <Segmented<ExportScope>
            block
            vertical
            value={scope}
            onChange={setChosenScope}
            options={definition.scopes.map((value) => ({
              value,
              disabled: isScopeDisabled(value),
              label: (
                <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 6 }}>
                  {SCOPES[value].icon}
                  {value === "selected" && selectedCount > 0 ? `${SCOPES[value].label(locale)} (${selectedCount})` : SCOPES[value].label(locale)}
                </span>
              ),
            }))}
          />
        </>
      ) : null}
      {selectionBlocked && definition.scopes.includes("selected") ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {locale.errorMessages.export_selection_key}
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {locale.exportFormat}
      </Typography.Text>
      {waitForLoad ? (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          {locale.exportWaitForLoad}
        </Typography.Text>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {definition.formats.map((format) => (
          <Button
            key={format}
            type="text"
            block
            icon={FORMATS[format].icon}
            disabled={isExporting || isScopeDisabled(scope) || waitForLoad}
            style={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 4 }}
            onClick={() => {
              setOpen(false);
              onExport(format, scope);
            }}
          >
            {FORMATS[format].label}
          </Button>
        ))}
      </div>
    </div>
  );

  const trigger = (
    <Popover content={panel} trigger="click" placement="bottomLeft" open={open} onOpenChange={setOpen}>
      <Button size="small" icon={<DownloadIcon />} loading={isExporting} disabled={!definition.formats.length || !definition.scopes.length}>
        {isExporting && progress ? locale.exporting(progress.current, progress.total) : locale.export}
      </Button>
    </Popover>
  );
  if (!isExporting || !onCancel) return trigger;
  return (
    <Space.Compact>
      {trigger}
      <Button size="small" onClick={onCancel}>{locale.cancelExport}</Button>
    </Space.Compact>
  );
}
