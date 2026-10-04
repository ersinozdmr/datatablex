import { useMemo, useState } from "react";
import { Badge, Segmented, Space, Tag, Typography } from "antd";
import { DataTable } from "@datatablex/antd";
import { createRestDataSource } from "@datatablex/react";
import type { ReactDataTableColumn } from "@datatablex/react";
import type { FilterGroup } from "@datatablex/core";

/**
 * Matches the `fields` keys in `accessLogsConfig.ts` of `@datatablex/fastify`
 * EXACTLY: the whitelisted camelCase field names are the shape of the response.
 */
interface AccessLog {
  id: number;
  accessDate: string;
  visitDay: string;
  stadiumName: string;
  ticketPrice: number;
  status: "open" | "closed" | "pending";
  active: boolean;
  nationalIdMasked: string;
}

type DemoRole = "operator" | "admin";
type DemoView = "all" | "active";

/**
 * Per-tab pre-filter (`lockedFilters`): the user cannot remove it and it is not
 * written to the URL. It is NOT a security boundary: the scope that hides
 * deleted records is applied in the backend with `scope`.
 */
const ACTIVE_ONLY: FilterGroup = { operator: "AND", filters: [{ field: "active", operator: "eq", value: true }] };

function statusLabel(value: AccessLog["status"]): string {
  return value === "open" ? "Open" : value === "closed" ? "Closed" : "Pending";
}

function activeLabel(value: boolean): string {
  return value ? "Active" : "Inactive";
}

function buildColumns(role: DemoRole): ReactDataTableColumn<AccessLog>[] {
  return [
    { key: "stadiumName", title: "Stadium", type: "text", sortable: true, filterable: true },
    {
      key: "accessDate",
      title: "Access Time",
      type: "datetime",
      timezone: "Europe/Istanbul",
      sortable: true,
      filterable: true,
      tabularNums: true,
    },
    {
      key: "visitDay",
      title: "Visit Day",
      type: "date",
      sortable: true,
      filterable: true,
      tabularNums: true,
    },
    {
      key: "ticketPrice",
      title: "Ticket Price (₺)",
      type: "currency",
      currency: "TRY",
      sortable: true,
      filterable: true,
      tabularNums: true,
    },
    {
      key: "status",
      title: "Status",
      type: "enum",
      filterable: true,
      /* options: [
        { label: "Open", value: "open" },
        { label: "Closed", value: "closed" },
        { label: "Pending", value: "pending" },
      ], */
      // No `options` are given: the filter options come from the server (see
      // `status.options` in accessLogsConfig.ts). The meta reports `hasOptions`,
      // and the list is fetched once, when the filter is first opened.
      exportValue: (record) => statusLabel(record.status),
      render: (value) => {
        const status = value === "open" ? "success" : value === "closed" ? "error" : "warning";
        return <Badge status={status} text={statusLabel(value as AccessLog["status"])} />;
      },
    },
    {
      key: "active",
      title: "Active",
      type: "boolean",
      filterable: true,
      exportValue: (record) => activeLabel(record.active),
      render: (value) => (
        <Tag color={value === true ? "success" : "error"}>{activeLabel(value === true)}</Tag>
      ),
    },
    {
      // Column roles: the filter goes to the backend's raw, invisible
      // `nationalId` field (`field`, which defaults to `key`), so an operator
      // can find a record by the FULL national ID number (the last 4 digits can
      // collide across several records); the displayed value is the masked
      // `nationalIdMasked` (`accessor`). The raw `nationalId` never enters the
      // response (`sensitive: true`). `filterOperators: ["eq"]` makes the box
      // produce `eq` instead of `contains`; the endpoint meta narrows it the
      // same way, and spelling it out here also covers a filter box that opens
      // before the meta arrives.
      key: "nationalId",
      accessor: "nationalIdMasked",
      title: role === "admin" ? "National ID" : "National ID (masked)",
      type: "text",
      filterable: true,
      filterOperators: ["eq"],
      // Even the masked value is identity data, so it is not written to the
      // example export file. This is a UI choice, not a real security
      // boundary: the raw value must not be in the response in the first place.
      exportable: false,
    },
    {
      // Computed column: it has no backend counterpart (`field: null`) and its
      // value is derived from two fields. Sorting and filtering are off; search
      // and export use the displayed value. Hidden initially, and can be shown
      // from the column panel.
      key: "summary",
      field: null,
      accessor: (record) => `${record.stadiumName} · ${statusLabel(record.status)}`,
      title: "Summary",
      defaultHidden: true,
    },
  ];
}

/**
 * The example application does NOT include JWT verification (see the README,
 * "Out of scope"). This selector exists for ONE purpose: to let the
 * `nationalIdMasked` / raw `nationalId` distinction in `accessLogsConfig.ts`
 * be triggered from the browser without building a real session system. When
 * the role changes, `DataTable` is remounted through `key` (filter and page
 * state are RESET), which is the simplest way to start over with a new
 * `x-demo-role` header.
 */
export function AccessLogsScreen() {
  const [role, setRole] = useState<DemoRole>("operator");
  const [view, setView] = useState<DemoView>("all");
  // Reference stability of `dataSource` and `columns` is part of the library's
  // contract, so they are rebuilt only when the role changes.
  const dataSource = useMemo(
    () =>
      createRestDataSource<AccessLog>({
        endpoint: "/api/access-logs/query",
        metaEndpoint: "/api/access-logs/query/meta",
        // Excel, PDF and CSV are produced on the server. The download is the
        // browser's own request and cannot carry `x-demo-role`, so the admin
        // config's ticket lives at its own address (see src/server/index.ts).
        exportEndpoint: role === "admin" ? "/api/access-logs/admin/export" : "/api/access-logs/query/export",
        headers: { "x-demo-role": role },
      }),
    [role],
  );
  const columns = useMemo(() => buildColumns(role), [role]);

  return (
    <div style={{ padding: "0px 24px 12px 24px", maxWidth: 1400, margin: "0 auto" }}>
      <Typography.Title level={3}>DataTableX — Access Logs (Example Application)</Typography.Title>
      <Typography.Paragraph type="secondary">
        The table, filter bar and advanced builder, URL sync and CSV/Excel/PDF export run on a real
        PostgreSQL database.
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 16 }}>
        <Segmented<DemoRole>
          value={role}
          onChange={setRole}
          options={[
            { label: "Operator (masked)", value: "operator" },
            { label: "Admin (unmasked)", value: "admin" },
          ]}
        />
        <Segmented<DemoView>
          value={view}
          onChange={setView}
          options={[
            { label: "All records", value: "all" },
            { label: "Active only", value: "active" },
          ]}
        />
      </Space>
      <DataTable<AccessLog>
        key={role}
        tableId="access-logs-table"
        dataSource={dataSource}
        columns={columns}
        rowKey="id"
        headerDensity="compact"
        density="xsmall"
        selectable
        columnManagement
        filterBar={{ mode: "advanced" }}
        // The query is carried in the URL: a filtered link can be shared, and the back button undoes a page change.
        syncWithUrl
        // A shared link is normalized with the meta limits and opens with a SINGLE request.
        awaitMeta
        lockedFilters={view === "active" ? ACTIVE_ONLY : null}
        export={{ formats: ["csv", "excel", "pdf"], scopes: ["currentPage", "allFiltered", "selected"] }}
      />
    </div>
  );
}
