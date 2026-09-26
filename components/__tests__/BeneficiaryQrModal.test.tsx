// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BeneficiaryQrModal from "../BeneficiaryQrModal";

const ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

describe("BeneficiaryQrModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <BeneficiaryQrModal address={ADDRESS} open={false} onClose={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the QR code and address when open", () => {
    render(<BeneficiaryQrModal address={ADDRESS} open={true} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText(ADDRESS).length).toBeGreaterThan(0);
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<BeneficiaryQrModal address={ADDRESS} open={true} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
