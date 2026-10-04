import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import type { Locator, Page } from "@playwright/test";
import { encodeFilterParam } from "@datatablex/core";
import type { FilterGroup } from "@datatablex/core";

/** Same value as in `scripts/seed.ts`: the known national ID looked up in the exact-match scenario. */
const KNOWN_NATIONAL_ID = "10000000146";
const QUERY_URL = "/api/access-logs/query";

/** Tag of the scenarios that also run on Firefox and WebKit (see playwright.config.ts). */
const CROSS_BROWSER = { tag: "@cross-browser" };

const bodyRows = (page: Page) => page.locator(".ant-table-tbody tr.ant-table-row");

/**
 * Waits for a UI action together with the RESPONSE of the query it triggers.
 * A fixed `waitForTimeout` for the debounce would let an assertion run before
 * the response arrives on a slow machine.
 */
async function withQuery(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse((r) => r.url().endsWith(QUERY_URL) && r.request().method() === "POST");
  await action();
  return response;
}

async function openTable(page: Page) {
  await withQuery(page, () => page.goto("/"));
  await expect(bodyRows(page).first()).toBeVisible();
}

/** 1-based position of the column with the given header text, for checking cell contents column by column. */
async function columnIndex(page: Page, title: string): Promise<number> {
  const titles = await page.locator(".ant-table-thead th").allTextContents();
  // The header of a sorted column also carries a direction arrow (↑/↓).
  const index = titles.findIndex((t) => t.replace(/[↑↓]/g, "").trim() === title);
  expect(index, `Header "${title}" not found: ${titles.join(" | ")}`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

/**
 * With the filter bar open, "Filter" in the header menu opens the rule editor
 * for that field in the bar. If the field has a single rule, the editor of that
 * rule opens.
 */
async function openFieldFilter(page: Page, title: string) {
  await page.locator(".ant-table-thead").getByText(title, { exact: true }).click();
  await page.getByRole("menuitem", { name: /Filter/ }).click();
}

/**
 * Ant Design `Select`: opens the combobox and picks the option from the
 * dropdown list the combobox is linked to through `aria-controls`.
 *
 * - The click goes to the `.ant-select-selector` that wraps the input, not to
 *   the input itself: the `span` that shows the selected value sits on top of
 *   the input. `force` is not used, because it skips Playwright's visibility and
 *   stability waits during the popover's opening animation and fails with an
 *   "outside of the viewport" error.
 * - Taking the option from "the last visible list" could catch another list
 *   that is still in its closing animation and make the test flaky.
 */
async function pick(page: Page, combobox: Locator, option: string) {
  await combobox.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' ant-select-selector ')][1]").click();
  const listId = await combobox.getAttribute("aria-controls");
  await page.locator(`.ant-select-dropdown:has([id="${listId}"])`).getByTitle(option, { exact: true }).click();
}

async function chooseOption(page: Page, combobox: string, option: string) {
  await pick(page, page.getByRole("combobox", { name: combobox }), option);
}

const filterBar = (page: Page) => page.getByRole("group", { name: "Filters" });

/** Opens the table with a "Stadium contains `text`" filter; the example has no search box, so the stadium filter does its job. */
async function openWithStadium(page: Page, text: string) {
  const tree: FilterGroup = { operator: "AND", filters: [{ field: "stadiumName", operator: "contains", value: text }] };
  await withQuery(page, () => page.goto(`/?f=${encodeFilterParam(tree)}`));
}

async function exportAs(page: Page, scope: string, format: RegExp) {
  await page.getByText("Export", { exact: true }).click();
  await page.getByText(scope, { exact: true }).click();
  await page.getByRole("button", { name: format }).click();
}

/** RFC 4180: quoted cells contain no line breaks; rows are separated by CRLF. */
const csvLines = (csv: string) => csv.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);

/**
 * Starts the export from the menu and waits for the browser's native download:
 * the file streams from the server straight into the browser's download and
 * never passes through the page's JavaScript. The "Download started"
 * notification is verified as well.
 */
async function downloadAs(page: Page, scope: string, format: RegExp): Promise<{ filename: string; body: Buffer }> {
  const downloadEvent = page.waitForEvent("download", { timeout: 120_000 });
  await exportAs(page, scope, format);
  const download = await downloadEvent;
  await expect(page.getByText("Download started. You can find the file in your browser's downloads.")).toBeVisible();
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer);
  expect(await download.failure()).toBeNull();
  return { filename: download.suggestedFilename(), body: Buffer.concat(chunks) };
}

test.describe("Access Logs — end to end on a real PostgreSQL", () => {
  test("the table loads and shows the seeded rows", CROSS_BROWSER, async ({ page }) => {
    await openTable(page);
    await expect(page.getByRole("heading", { name: "DataTableX — Access Logs (Example Application)" })).toBeVisible();
    await expect(bodyRows(page)).toHaveCount(20);
  });

  test("the filter bar filters on a stadium name with Turkish characters", async ({ page }) => {
    await openTable(page);
    await filterBar(page).getByRole("button", { name: /Add filter/ }).click();
    await chooseOption(page, "Field", "Stadium");
    await chooseOption(page, "Condition", "contains");
    await page.getByRole("textbox", { name: "Stadium Value" }).fill("Şükrü Saracoğlu");
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());

    const rows = bodyRows(page);
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText("Şükrü Saracoğlu");
    }
  });

  test("the 'This page' CSV downloads natively from the server; a formula cell becomes safe text", CROSS_BROWSER, async ({ page }) => {
    await openWithStadium(page, "=cmd|");
    await expect(bodyRows(page)).toHaveCount(1);

    const { filename, body } = await downloadAs(page, "This page", /CSV/);
    const csv = body.toString("utf8");
    expect(filename).toMatch(/^access-logs-table-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("'=cmd|");
    expect(csv).not.toContain("National ID (masked)");
    expect(csvLines(csv)).toHaveLength(2);
  });

  test("the 'Filtered rows' CSV downloads with a single ticket request; no paged requests, and the row count equals the total", CROSS_BROWSER, async ({ page }) => {
    const pending: FilterGroup = { operator: "AND", filters: [{ field: "status", operator: "in", value: ["pending"] }] };
    const first = await withQuery(page, () => page.goto(`/?f=${encodeFilterParam(pending)}`));
    const total = ((await first.json()) as { pagination: { total: number } }).pagination.total;
    // Seed weighting: "pending" is ~15%, so a paged path would need dozens of pages.
    expect(total).toBeGreaterThan(5_000);
    await expect(bodyRows(page).first()).toBeVisible();

    let pagedRequests = 0;
    const tickets: Array<{ scope: string; query: { filters: unknown }; columns: Array<{ field: string }> }> = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      if (request.url().endsWith(QUERY_URL)) pagedRequests++;
      if (request.url().endsWith(`${QUERY_URL}/export/ticket`)) tickets.push(request.postDataJSON());
    });
    const { body } = await downloadAs(page, "Filtered rows", /CSV/);

    expect(pagedRequests).toBe(0);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ scope: "allFiltered", query: { filters: pending } });
    expect(tickets[0]!.columns.map((c) => c.field)).not.toContain("nationalIdMasked");
    const lines = csvLines(body.toString("utf8"));
    expect(lines[0]).toContain('"Status"');
    expect(lines).toHaveLength(1 + total);
    // The label comes from the server's formatter.
    expect(lines.slice(1).filter((line) => !line.includes('"Pending"'))).toEqual([]);
  });

  test("the 'Filtered rows' Excel downloads the whole table (~50K rows) from the server; no browser cap", CROSS_BROWSER, async ({ page }) => {
    const first = await withQuery(page, () => page.goto("/"));
    const total = ((await first.json()) as { pagination: { total: number } }).pagination.total;
    expect(total).toBeGreaterThan(10_000);
    await expect(bodyRows(page).first()).toBeVisible();

    const { filename, body } = await downloadAs(page, "Filtered rows", /Excel/);
    expect(filename).toMatch(/\.xlsx$/);
    expect(body.subarray(0, 4).toString("latin1")).toBe("PK\u0003\u0004");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("Export")!;
    expect(sheet.rowCount).toBe(1 + total);
    expect(sheet.getRow(1).font?.bold).toBe(true);
  });

  test("PDF: 'This page' is generated on the server and a valid document downloads", CROSS_BROWSER, async ({ page }) => {
    await openTable(page);
    const { filename, body } = await downloadAs(page, "This page", /PDF/);
    expect(filename).toMatch(/\.pdf$/);
    const pdf = body.toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  test("the 'Selected rows' CSV carries only the selected rows, as keys in the ticket request", CROSS_BROWSER, async ({ page }) => {
    await openTable(page);
    const checkboxes = page.locator(".ant-table-tbody .ant-checkbox-input");
    await checkboxes.nth(0).check();
    await checkboxes.nth(2).check();
    await expect(page.getByTestId("selection-summary")).toContainText("2 selected");

    const ticket = page.waitForRequest((request) => request.url().endsWith(`${QUERY_URL}/export/ticket`));
    // While rows are selected, the scope label carries the count.
    const { body } = await downloadAs(page, "Selected rows (2)", /CSV/);
    expect((await ticket).postDataJSON()).toMatchObject({ scope: "selected", keys: [expect.any(Number), expect.any(Number)] });
    expect(csvLines(body.toString("utf8"))).toHaveLength(3);
  });

  test("in the admin role the export gets its ticket from the admin URL and downloads", CROSS_BROWSER, async ({ page }) => {
    await openTable(page);
    await withQuery(page, () => page.getByText("Admin (unmasked)").click());
    await expect(bodyRows(page).first()).toBeVisible();

    const ticket = page.waitForRequest((request) => request.url().includes("/export/ticket"));
    const { body } = await downloadAs(page, "This page", /CSV/);
    expect((await ticket).url()).toMatch(/\/api\/access-logs\/admin\/export\/ticket$/);
    expect(csvLines(body.toString("utf8"))).toHaveLength(21);
  });

  test("export cancel: 'Cancel' while the ticket is pending starts no download and shows no error; the next export works", CROSS_BROWSER, async ({ page }) => {
    await openTable(page);

    // The first ticket request is held until the test releases it: the export is "in progress" meanwhile and Cancel is visible.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstTicketSettled!: Promise<void>;
    let ticketRequests = 0;
    await page.route(`**${QUERY_URL}/export/ticket`, (route) => {
      ticketRequests++;
      const settle = (ticketRequests === 1 ? held : Promise.resolve())
        // Continuing the cancelled request is rejected by the browser; this is expected.
        .then(() => route.continue())
        .catch(() => undefined);
      if (ticketRequests === 1) firstTicketSettled = settle;
      return settle;
    });
    // A native download does not show up as a page request in Chromium and WebKit; the `download` event arrives in all three browsers.
    let downloads = 0;
    page.on("download", () => downloads++);

    await exportAs(page, "This page", /CSV/);
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await cancel.click();
    await expect(cancel).toBeHidden();
    release();
    await firstTicketSettled;

    // Cancelling is silent: no download, no notification, no error.
    expect(downloads).toBe(0);
    await expect(page.getByText("Download started. You can find the file in your browser's downloads.")).toHaveCount(0);
    await expect(page.locator(".ant-message-error")).toHaveCount(0);

    // The export state has been cleared: the second export downloads normally. If
    // the cancelled ticket had arrived late, its download would have started
    // before the second one; the total stays at a single download.
    const { body } = await downloadAs(page, "This page", /CSV/);
    expect(csvLines(body.toString("utf8"))).toHaveLength(21);
    expect(ticketRequests).toBe(2);
    expect(downloads).toBe(1);
  });

  test("a number column sorts ascending with the type-specific label and pagination moves to page 2", async ({ page }) => {
    await openTable(page);
    const header = page.locator(".ant-table-thead th", { hasText: "Ticket Price (₺)" });
    await page.getByText("Ticket Price (₺)").click();
    await page.getByRole("menuitem", { name: /Sort/ }).click();
    await withQuery(page, () => page.getByText("Sort smallest to largest").click());
    await expect(header).toHaveAttribute("aria-sort", "ascending");

    const priceColumn = await columnIndex(page, "Ticket Price (₺)");
    const prices = (await page.locator(`.ant-table-tbody tr.ant-table-row td:nth-child(${priceColumn})`).allTextContents()).map(Number);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    // `getByTitle` matches substrings: "2" would match page 2, other page numbers
    // such as "2501" and the "20 / page" selector.
    await withQuery(page, () => page.getByTitle("2", { exact: true }).click());
    await expect(page.locator(".ant-pagination-item-active")).toContainText("2");
  });

  test("the status filter shows only the selected value", async ({ page }) => {
    await openTable(page);
    await openFieldFilter(page, "Status");
    // The text "Closed" also appears in table cells (the status badge), so the lookup is limited to the editor popover.
    const closed = page.locator(".ant-popover:visible").getByLabel("Closed");
    await closed.click();
    await expect(closed).toBeChecked();
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    await expect(filterBar(page).getByRole("button", { name: "Status is any of Closed — edit" })).toBeVisible();

    const statusColumn = await columnIndex(page, "Status");
    const cells = page.locator(`.ant-table-tbody tr.ant-table-row td:nth-child(${statusColumn})`);
    await expect(cells).toHaveCount(20);
    for (const text of await cells.allTextContents()) expect(text).toBe("Closed");
  });

  test("in the operator role the national ID is masked; in the admin role it is shown unmasked", async ({ page }) => {
    await openTable(page);
    const maskedColumn = await columnIndex(page, "National ID (masked)");
    for (const text of await page.locator(`.ant-table-tbody tr.ant-table-row td:nth-child(${maskedColumn})`).allTextContents()) {
      expect(text).toMatch(/^\*{7}\d{4}$/);
    }

    await withQuery(page, () => page.getByText("Admin (unmasked)").click());
    await expect(bodyRows(page).first()).toBeVisible();
    const rawColumn = await columnIndex(page, "National ID");
    for (const text of await page.locator(`.ant-table-tbody tr.ant-table-row td:nth-child(${rawColumn})`).allTextContents()) {
      expect(text).toMatch(/^\d{11}$/);
    }
  });

  test("the national ID is found only by its exact value; a partial value returns no rows", async ({ page }) => {
    await openTable(page);

    await openFieldFilter(page, "National ID (masked)");
    await page.getByRole("textbox", { name: "National ID (masked) Value" }).fill(KNOWN_NATIONAL_ID.slice(0, 6));
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    await expect(page.getByText("No records found")).toBeVisible();
    // The editor in its closing animation can stay visible for a moment together with the one about to open.
    await expect(page.getByRole("textbox", { name: "National ID (masked) Value" })).toHaveCount(0);

    // The field has a single rule, so the shortcut opens the editor of that same rule.
    await openFieldFilter(page, "National ID (masked)");
    await page.getByRole("textbox", { name: "National ID (masked) Value" }).fill(KNOWN_NATIONAL_ID);
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    await expect(bodyRows(page)).toHaveCount(1);
    await expect(bodyRows(page).first()).toContainText("Kimlik Tam Eşleşme Kaydı");
    await expect(bodyRows(page).first()).toContainText(`*******${KNOWN_NATIONAL_ID.slice(-4)}`);
  });

  /**
   * Predicate-oracle regression: substring filtering and search on the raw
   * national ID are CLOSED on the server side, even if a client skips the UI and
   * sends the request directly.
   */
  test("API: contains on the raw national ID gets 400; global search does not scan the national ID", async ({ request }) => {
    const base = { pagination: { page: 1, pageSize: 20 }, sorting: [] };

    const contains = await request.post(QUERY_URL, {
      data: { ...base, filters: { operator: "AND", filters: [{ field: "nationalId", operator: "contains", value: "1000" }] } },
    });
    expect(contains.status()).toBe(400);

    const search = await request.post(QUERY_URL, { data: { ...base, filters: null, search: KNOWN_NATIONAL_ID } });
    expect(search.status()).toBe(200);
    expect((await search.json()).pagination.total).toBe(0);
  });

  /**
   * `notContains` and `contains` split the same field into two complementary
   * sets: because `stadium_name` is NOT NULL, their totals add up to all visible
   * rows, and none of the returned rows contains the term (case-insensitive).
   */
  test("API: notContains is the complement of contains and returns no matching row", async ({ request }) => {
    const query = (operator: string) =>
      request.post(QUERY_URL, {
        data: {
          pagination: { page: 1, pageSize: 100 },
          sorting: [],
          filters: { operator: "AND", filters: [{ field: "stadiumName", operator, value: "KADIR HAS" }] },
        },
      });
    const all = await (await request.post(QUERY_URL, { data: { pagination: { page: 1, pageSize: 1 }, sorting: [], filters: null } })).json();
    const contains = await (await query("contains")).json();
    const notContains = await (await query("notContains")).json();

    expect(contains.pagination.total).toBeGreaterThan(0);
    expect(contains.pagination.total + notContains.pagination.total).toBe(all.pagination.total);
    for (const row of notContains.data) expect(row.stadiumName.toLocaleLowerCase("tr")).not.toContain("kadir has");
  });

  test("API: the meta route returns limits and fields and does not expose the database mapping", async ({ request }) => {
    const res = await request.get(`${QUERY_URL}/meta`);
    expect(res.status()).toBe(200);
    const meta = await res.json();
    expect(meta).toMatchObject({ version: 1, primaryKey: "id", limits: { maxPageSize: 500, maxSearchLength: 200 } });
    expect(meta.fields.nationalId).toEqual({ type: "text", filterOperators: ["eq"], sortable: false, searchable: false });
    expect(JSON.stringify(meta)).not.toContain("national_id_masked");
  });

  test("API: the options route returns the status list in a versioned body; a field without options and an unknown field get 400", async ({ request }) => {
    const meta = await (await request.get(`${QUERY_URL}/meta`)).json();
    expect(meta.fields.status.hasOptions).toBe(true);
    expect(meta.fields.stadiumName.hasOptions).toBeUndefined();

    const res = await request.get(`${QUERY_URL}/options/status`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(await res.json()).toEqual({
      version: 1,
      options: [
        { label: "Open", value: "open" },
        { label: "Closed", value: "closed" },
        { label: "Pending", value: "pending" },
      ],
    });

    for (const field of ["stadiumName", "nationalId", "ghost"]) {
      const denied = await request.get(`${QUERY_URL}/options/${field}`);
      expect(denied.status()).toBe(400);
      expect((await denied.json()).code).toBe("field_not_allowed");
    }
  });

  test("the status filter fetches its options from the server once; the chip of a filter that comes from the URL shows the label", async ({ page }) => {
    const optionRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/query/options/")) optionRequests.push(new URL(req.url()).pathname);
    });
    await openTable(page);
    // Lazy: no request before the filter is opened.
    expect(optionRequests).toEqual([]);

    await openFieldFilter(page, "Status");
    const closed = page.locator(".ant-popover:visible").getByLabel("Closed");
    await closed.click();
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    const chip = filterBar(page).getByRole("button", { name: "Status is any of Closed — edit" });
    await expect(chip).toBeVisible();
    expect(optionRequests).toEqual(["/api/access-logs/query/options/status"]);

    // Reload: the filter comes from the URL; the chip shows the label ("Closed", not the raw "closed") without the editor being opened.
    await page.reload();
    await expect(chip).toBeVisible();
    expect(optionRequests).toEqual(["/api/access-logs/query/options/status", "/api/access-logs/query/options/status"]);
  });

  test("API: the server export streams CSV from a single snapshot; the row count equals COUNT and the /query total", async ({ request }) => {
    const filters: FilterGroup = { operator: "AND", filters: [{ field: "status", operator: "in", value: ["closed"] }] };
    const expected = (await (await request.post(QUERY_URL, { data: { pagination: { page: 1, pageSize: 1 }, sorting: [], filters } })).json()).pagination.total;
    expect((await (await request.get(`${QUERY_URL}/meta`)).json()).export).toMatchObject({ formats: { csv: 10_000_000 } });

    const ticketRes = await request.post(`${QUERY_URL}/export/ticket`, {
      data: {
        query: { sorting: [{ field: "accessDate", direction: "desc" }], filters },
        format: "csv",
        columns: [
          { field: "id", title: "No" },
          { field: "status", title: "Status" },
          { field: "active", title: "Active" },
        ],
        filename: "kapalı-geçişler",
      },
    });
    expect(ticketRes.status()).toBe(200);
    const res = await request.get(`${QUERY_URL}/export/download?ticket=${(await ticketRes.json()).ticket}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers()["content-disposition"]).toContain(`filename*=UTF-8''${encodeURIComponent("kapalı-geçişler.csv")}`);
    expect(Number(res.headers()["x-datatablex-total"])).toBe(expected);

    const lines = (await res.text()).split("\r\n").filter(Boolean);
    expect(lines[0]).toBe('\uFEFF"No","Status","Active"');
    expect(lines).toHaveLength(expected + 1);
    // The server formatter writes the labels; the raw enum/boolean value never reaches the file.
    // (A separate `expect` per row took seconds over thousands of rows; one check is enough.)
    expect(lines.slice(1).filter((line) => !/^"\d+","Closed","(Active|Inactive)"$/.test(line))).toEqual([]);
  });

  test("API: a ticket is single-use; the download serves the file without headers, the second use is a 410 file", async ({ request }) => {
    const filters: FilterGroup = { operator: "AND", filters: [{ field: "status", operator: "in", value: ["closed"] }] };
    const meta = await (await request.get(`${QUERY_URL}/meta`)).json();
    expect(meta.export).toMatchObject({ formats: { csv: 10_000_000, excel: 1_000_000, pdf: 100_000 } });

    const ticketRes = await request.post(`${QUERY_URL}/export/ticket`, {
      data: { query: { sorting: [], filters }, format: "csv", columns: [{ field: "id", title: "No" }, { field: "status", title: "Status" }], filename: "kapalı" },
    });
    expect(ticketRes.status()).toBe(200);
    const ticket = await ticketRes.json();
    expect(ticket).toMatchObject({ filename: "kapalı.csv" });
    expect(ticket.total).toBeGreaterThan(0);

    // Like a browser download: no headers (this context carries no cookies either), only the ticket.
    const file = await request.get(`${QUERY_URL}/export/download?ticket=${ticket.ticket}`);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-disposition"]).toContain("attachment;");
    expect(Number(file.headers()["x-datatablex-total"])).toBe(ticket.total);
    expect((await file.text()).split("\r\n").filter(Boolean)).toHaveLength(ticket.total + 1);

    const reused = await request.get(`${QUERY_URL}/export/download?ticket=${ticket.ticket}`);
    expect(reused.status()).toBe(410);
    expect(reused.headers()["content-disposition"]).toContain("export-error.txt");
  });

  test("API: an admin ticket is issued at the admin URL and downloads with the admin identity; a ticket request without a role gets 403", async ({ request }) => {
    const payload = { query: { sorting: [], filters: null }, format: "csv", columns: [{ field: "id", title: "No" }] };
    expect((await request.post("/api/access-logs/admin/export/ticket", { data: payload })).status()).toBe(403);
    const ticketRes = await request.post("/api/access-logs/admin/export/ticket", { data: payload, headers: { "x-demo-role": "admin" } });
    expect(ticketRes.status()).toBe(200);
    const { ticket } = await ticketRes.json();
    // The operator URL does not recognize the admin's ticket: each config has its own store.
    expect((await request.get(`${QUERY_URL}/export/download?ticket=${ticket}`)).status()).toBe(410);
    const adminTicket = (await (await request.post("/api/access-logs/admin/export/ticket", { data: payload, headers: { "x-demo-role": "admin" } })).json()).ticket;
    expect((await request.get(`/api/access-logs/admin/export/download?ticket=${adminTicket}`)).status()).toBe(200);
  });

  test("API: the server export rejects a field outside the whitelist (masked or raw national ID) with 400", async ({ request }) => {
    for (const field of ["nationalIdMasked", "nationalId"]) {
      const res = await request.post(`${QUERY_URL}/export/ticket`, {
        data: { query: { sorting: [], filters: null }, format: "csv", columns: [{ field, title: "National ID" }] },
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).details[0].path).toEqual(["columns", 0, "field"]);
    }
  });

  test("API: an unsupported protocol version gets a clear 400; meta reports the version", async ({ request }) => {
    const body = { pagination: { page: 1, pageSize: 5 }, sorting: [], filters: null };
    const rejected = await request.post(QUERY_URL, { data: body, headers: { "x-datatablex-protocol": "2" } });
    expect(rejected.status()).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "Unsupported Protocol", supported: [1] });
    expect((await request.post(QUERY_URL, { data: body, headers: { "x-datatablex-protocol": "1" } })).status()).toBe(200);
    expect((await (await request.get(`${QUERY_URL}/meta`)).json()).protocol).toEqual({ version: 1, supported: [1] });
  });

  /**
   * Real-PostgreSQL regression: the `datetime` day filter is half-open. For
   * 15 January 2025 in Istanbul it must include the rows at the start of the day
   * and at `23:59:59.999500`, and exclude the row at 16 January 00:00. An
   * inclusive `23:59:59.999` upper bound would miss the microsecond row.
   */
  test("the datetime day filter does not lose PostgreSQL microseconds", async ({ page }) => {
    await openWithStadium(page, "Mikrosaniye Sınır Kaydı");
    await expect(bodyRows(page)).toHaveCount(3);

    // The "on" rule compiles to a half-open gte+lt group in the column's timezone.
    await openFieldFilter(page, "Access Time");
    await chooseOption(page, "Condition", "on");
    await page.getByLabel("Access Time Value").fill("2025-01-15");
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());

    await expect(bodyRows(page)).toHaveCount(2);
  });

  test("filter bar: a does-not-contain rule is added, narrows the rows and is removed from the chip", async ({ page }) => {
    await openTable(page);
    await filterBar(page).getByRole("button", { name: /Add filter/ }).click();
    await chooseOption(page, "Field", "Stadium");
    await chooseOption(page, "Condition", "does not contain");
    await expect(page.getByText("(empty values excluded)")).toBeVisible();
    await page.getByRole("textbox", { name: "Stadium Value" }).fill("Stadyumu");
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());

    const chip = filterBar(page).getByRole("button", { name: "Stadium does not contain Stadyumu — edit" });
    await expect(chip).toBeVisible();
    const stadiumColumn = await columnIndex(page, "Stadium");
    const names = await page.locator(`.ant-table-tbody tr.ant-table-row td:nth-child(${stadiumColumn})`).allTextContents();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.toLocaleLowerCase("tr")).not.toContain("stadyumu");

    await withQuery(page, () => filterBar(page).getByRole("button", { name: "Remove filter Stadium does not contain Stadyumu" }).click());
    await expect(chip).toHaveCount(0);
    await expect(bodyRows(page)).toHaveCount(20);
  });

  test("advanced builder: (Status = Closed OR Price ≥ 400) AND Stadium does not contain Park", async ({ page }) => {
    await openTable(page);
    await filterBar(page).getByRole("button", { name: "Advanced" }).click();
    const panel = page.getByRole("region", { name: "Advanced" });
    const root = panel.getByRole("group").first();

    await root.getByRole("button", { name: /Add rule/ }).last().click();
    await pick(page, panel.getByRole("combobox", { name: "Field" }).last(), "Stadium");
    await pick(page, panel.getByRole("combobox", { name: "Condition" }).last(), "does not contain");
    await panel.getByRole("textbox", { name: "Stadium Value" }).fill("Park");

    await root.getByRole("button", { name: /Add group/ }).last().click();
    const group = panel.getByRole("group").nth(1);
    await pick(page, group.getByRole("combobox", { name: "Field" }).last(), "Status");
    await group.getByLabel("Closed").click();
    await group.getByRole("button", { name: /Add rule/ }).last().click();
    await pick(page, group.getByRole("combobox", { name: "Field" }).last(), "Ticket Price (₺)");
    await pick(page, group.getByRole("combobox", { name: "Condition" }).last(), "greater than or equal");
    await group.getByRole("spinbutton", { name: "Ticket Price (₺) Value" }).fill("400");
    await pick(page, group.getByRole("combobox", { name: "Connective" }), "or");

    await withQuery(page, () => panel.getByRole("button", { name: "Apply" }).click());
    await expect(panel).toHaveCount(0);
    await expect(filterBar(page).getByRole("button", { name: /^\(Status is any of Closed or Ticket Price \(₺\) greater than or equal 400\) — edit$/ })).toBeVisible();

    const [stadium, status, price] = await Promise.all([
      columnIndex(page, "Stadium"),
      columnIndex(page, "Status"),
      columnIndex(page, "Ticket Price (₺)"),
    ]);
    const rowCount = await bodyRows(page).count();
    expect(rowCount).toBeGreaterThan(0);
    for (let i = 0; i < rowCount; i++) {
      const cells = bodyRows(page).nth(i).locator("td");
      expect((await cells.nth(stadium - 1).textContent())!.toLocaleLowerCase("tr")).not.toContain("park");
      const isClosed = (await cells.nth(status - 1).textContent())!.trim() === "Closed";
      const expensive = Number(await cells.nth(price - 1).textContent()) >= 400;
      expect(isClosed || expensive).toBe(true);
    }
  });

  test("URL: a link with a nested filter opens with that filter on the first request and shows as chips", async ({ page }) => {
    const tree: FilterGroup = {
      operator: "AND",
      filters: [
        { field: "stadiumName", operator: "notContains", value: "Park" },
        { operator: "OR", filters: [{ field: "status", operator: "in", value: ["closed"] }, { field: "ticketPrice", operator: "gte", value: 400 }] },
      ],
    };
    const bodies: unknown[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(QUERY_URL) && request.method() === "POST") bodies.push(request.postDataJSON());
    });
    await withQuery(page, () => page.goto(`/?f=${encodeFilterParam(tree)}`));
    await expect(bodyRows(page).first()).toBeVisible();

    // The default (unfiltered) query was never sent: the first request went out with the tree from the URL.
    expect((bodies[0] as { filters: unknown }).filters).toEqual(tree);
    await expect(filterBar(page).getByRole("button", { name: "Stadium does not contain Park — edit" })).toBeVisible();
    await expect(filterBar(page).getByRole("button", { name: /^\(Status is any of Closed or Ticket Price.*— edit$/ })).toBeVisible();
  });

  test("URL: a page change adds a history entry, a filter does not; the back button returns to the initial state", async ({ page }) => {
    await openTable(page);
    await withQuery(page, () => page.getByTitle("2", { exact: true }).click());
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);

    // A filter resets the page to 1 and REPLACES the current entry: no page stays in the URL.
    await filterBar(page).getByRole("button", { name: /Add filter/ }).click();
    await chooseOption(page, "Field", "Stadium");
    await chooseOption(page, "Condition", "contains");
    await page.getByRole("textbox", { name: "Stadium Value" }).fill("Kadir");
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    await expect(page).toHaveURL(/[?&]f=/);
    await expect(page).not.toHaveURL(/page=/);

    // Because the filter added no new entry, the back button returns straight to the initial state (unfiltered, page 1).
    await withQuery(page, () => page.goBack());
    await expect(page).not.toHaveURL(/f=/);
    await expect(filterBar(page).getByRole("button", { name: /Stadium contains Kadir/ })).toHaveCount(0);
    await expect(page.locator(".ant-pagination-item-active")).toHaveText("1");
  });

  test("URL + awaitMeta: a link with a pageSize above the limit is normalized against meta on the first request", async ({ page }) => {
    const bodies: Array<{ pagination: { pageSize: number } }> = [];
    page.on("request", (request) => {
      if (request.url().endsWith(QUERY_URL) && request.method() === "POST") bodies.push(request.postDataJSON());
    });
    await withQuery(page, () => page.goto("/?pageSize=5000"));
    await expect(bodyRows(page).first()).toBeVisible();

    // The first and only request is already clamped to maxPageSize (500); no request with 5000 was sent first.
    expect(bodies[0]!.pagination.pageSize).toBe(500);
    await expect.poll(() => page.evaluate(() => window.location.search)).toBe("?pageSize=500");
    expect(bodies).toHaveLength(1);
  });

  test("URL: a malformed f is ignored; the table opens with the other parameters", async ({ page }) => {
    await withQuery(page, () => page.goto("/?f=malformed-value&page=2"));
    await expect(bodyRows(page).first()).toBeVisible();
    await expect(page.locator(".ant-pagination-item-active")).toHaveText("2");
    await expect(filterBar(page).getByRole("button", { name: /edit/ })).toHaveCount(0);
  });

  test("URL: a filter applied from the bar survives a page reload", async ({ page }) => {
    await openTable(page);
    await openFieldFilter(page, "Status");
    await page.locator(".ant-popover:visible").getByLabel("Closed").click();
    await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    await expect(page).toHaveURL(/[?&]f=/);

    await withQuery(page, () => page.reload());
    await expect(filterBar(page).getByRole("button", { name: "Status is any of Closed — edit" })).toBeVisible();
  });

  test("locked filter: 'Active only' is added to the query, not written to the URL, and Clear all does not touch it", async ({ page }) => {
    await openTable(page);
    const activeIndex = await columnIndex(page, "Active");

    const response = await withQuery(page, () => page.getByText("Active only", { exact: true }).click());
    expect(response.request().postDataJSON().filters).toEqual({ operator: "AND", filters: [{ field: "active", operator: "eq", value: true }] });
    await expect(filterBar(page).getByRole("note", { name: /Locked filter: Active equals Yes/ })).toBeVisible();
    await expect(page).not.toHaveURL(/[?&]f=/);
    await expect(bodyRows(page).locator(`td:nth-child(${activeIndex})`).filter({ hasText: "Inactive" })).toHaveCount(0);

    // The user filter is ANDed next to it; "Clear all" removes only that one.
    await openFieldFilter(page, "Status");
    await page.locator(".ant-popover:visible").getByLabel("Closed").click();
    const combined = await withQuery(page, () => page.getByRole("button", { name: "Apply" }).click());
    expect(combined.request().postDataJSON().filters.filters).toHaveLength(2);
    const cleared = await withQuery(page, () => filterBar(page).getByRole("button", { name: "Clear all" }).click());
    expect(cleared.request().postDataJSON().filters).toEqual({ operator: "AND", filters: [{ field: "active", operator: "eq", value: true }] });
    await expect(filterBar(page).getByRole("note", { name: /Locked filter/ })).toBeVisible();
  });

  test("a soft-deleted record is never shown", async ({ page }) => {
    await openWithStadium(page, "Silinmiş Kayıt");
    await expect(page.getByText("No records found")).toBeVisible();
  });
});
