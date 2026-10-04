import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportMenu } from "../ExportMenu.js";

const definition = {
  formats: ["csv", "excel", "pdf"] as Array<"csv" | "excel" | "pdf">,
  scopes: ["currentPage", "allFiltered", "selected"] as Array<"currentPage" | "allFiltered" | "selected">,
};

function setup(selectedCount: number) {
  const onExport = vi.fn();
  render(<ExportMenu definition={definition} selectedCount={selectedCount} isExporting={false} progress={null} onExport={onExport} />);
  return { onExport, user: userEvent.setup() };
}

describe("<ExportMenu>", () => {
  it("exports by choosing the scope first, then the format", async () => {
    const { onExport, user } = setup(0);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Filtered rows"));
    await user.click(screen.getByRole("button", { name: /Excel/ }));
    expect(onExport).toHaveBeenCalledWith("excel", "allFiltered");
  });

  it("the default scope is the first defined scope", async () => {
    const { onExport, user } = setup(0);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("button", { name: /CSV/ }));
    expect(onExport).toHaveBeenCalledWith("csv", "currentPage");
  });

  it("the PDF option exports with the chosen scope", async () => {
    const { onExport, user } = setup(0);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("button", { name: /PDF/ }));
    expect(onExport).toHaveBeenCalledWith("pdf", "currentPage");
  });

  it("'Selected rows' is disabled when nothing is selected; the count is shown and it can be chosen when there is a selection", async () => {
    const empty = setup(0);
    await empty.user.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByRole("radio", { name: /Selected rows/ })).toBeDisabled();
  });

  it("exports with 'Selected rows (n)' when there is a selection", async () => {
    const { onExport, user } = setup(3);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Selected rows (3)"));
    await user.click(screen.getByRole("button", { name: /CSV/ }));
    expect(onExport).toHaveBeenCalledWith("csv", "selected");
  });

  it("while the table is loading, the 'This page' formats are disabled and 'Filtered rows' stays enabled", async () => {
    const onExport = vi.fn();
    render(<ExportMenu definition={definition} selectedCount={0} isExporting={false} progress={null} onExport={onExport} loading />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByText("This page cannot be exported while the table is loading.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /CSV/ })).toBeDisabled();

    await user.click(screen.getByText("Filtered rows"));
    await user.click(screen.getByRole("button", { name: /CSV/ }));
    expect(onExport).toHaveBeenCalledWith("csv", "allFiltered");
  });

  it("the Cancel button calls onCancel while an export is running", async () => {
    const onCancel = vi.fn();
    render(<ExportMenu definition={definition} selectedCount={0} isExporting progress={{ current: 10, total: 100 }} onExport={vi.fn()} onCancel={onCancel} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

