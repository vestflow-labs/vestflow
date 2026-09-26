// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import SearchFilterBar from "../SearchFilterBar";
import { matchesAddressOrToken } from "../../lib/tokens";

describe("SearchFilterBar (#647)", () => {
  it("renders search input with placeholder", () => {
    const onChange = vi.fn();
    render(
      <SearchFilterBar
        value=""
        onChange={onChange}
        placeholder="Filter by address prefix or token symbol..."
      />
    );

    const input = screen.getByRole("searchbox");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "Filter by address prefix or token symbol...");
  });

  it("triggers onChange as user types", () => {
    const onChange = vi.fn();
    render(<SearchFilterBar value="" onChange={onChange} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "GBB" } });

    expect(onChange).toHaveBeenCalledWith("GBB");
  });

  it("shows clear button when value is non-empty and resets filter on click", () => {
    const onChange = vi.fn();
    render(<SearchFilterBar value="GBBB" onChange={onChange} />);

    const clearBtn = screen.getByRole("button", { name: /clear filter/i });
    expect(clearBtn).toBeInTheDocument();

    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("displays result count when resultCount and totalCount are provided", () => {
    const onChange = vi.fn();
    render(
      <SearchFilterBar
        value="USDC"
        onChange={onChange}
        resultCount={3}
        totalCount={10}
      />
    );

    expect(screen.getByText(/showing/i)).toHaveTextContent("Showing 3 of 10");
  });
});

describe("matchesAddressOrToken (#647)", () => {
  const address1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
  const address2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA";
  const token1 = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  it("matches address prefix case-insensitively", () => {
    expect(matchesAddressOrToken("gbbb", [address1, address2], [token1])).toBe(true);
    expect(matchesAddressOrToken("GCCC", [address1, address2], [token1])).toBe(true);
    expect(matchesAddressOrToken("gzzz", [address1, address2], [token1])).toBe(false);
  });

  it("matches token symbol XLM and native token", () => {
    expect(matchesAddressOrToken("xlm", [address1], [token1])).toBe(true);
    expect(matchesAddressOrToken("XLM", [address1], [token1])).toBe(true);
  });

  it("matches address book labels", () => {
    expect(matchesAddressOrToken("alice", [address1], [token1], ["Alice Treasury"])).toBe(true);
    expect(matchesAddressOrToken("bob", [address1], [token1], ["Alice Treasury"])).toBe(false);
  });
});
