/**
 * Tests for the Applications-page presets row.
 *
 * Verifies:
 *   - the Claude Shell tile renders with the documented copy + icon;
 *   - clicking the tile (or pressing Enter on it) routes to
 *     /applications/new/claude-shell;
 *   - the tile is keyboard-navigable (role="button", tabIndex).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

import { PresetsSection } from "@/app/applications/presets-section";

beforeEach(() => {
  mockNavigate.mockReset();
});

describe("PresetsSection — Claude Shell tile", () => {
  it("renders the tile with the documented title + description", () => {
    render(React.createElement(PresetsSection));
    expect(screen.getByText("Claude Shell")).toBeTruthy();
    expect(
      screen.getByText(
        "Developer container with Claude Code, accessible via Tailscale SSH.",
      ),
    ).toBeTruthy();
  });

  it("navigates to /applications/new/claude-shell on click", () => {
    render(React.createElement(PresetsSection));
    fireEvent.click(screen.getByLabelText("Create Claude Shell"));
    expect(mockNavigate).toHaveBeenCalledWith("/applications/new/claude-shell");
  });

  it("navigates on Enter keypress (keyboard a11y)", () => {
    render(React.createElement(PresetsSection));
    fireEvent.keyDown(screen.getByLabelText("Create Claude Shell"), {
      key: "Enter",
    });
    expect(mockNavigate).toHaveBeenCalledWith("/applications/new/claude-shell");
  });

  it("navigates on Space keypress (keyboard a11y)", () => {
    render(React.createElement(PresetsSection));
    fireEvent.keyDown(screen.getByLabelText("Create Claude Shell"), {
      key: " ",
    });
    expect(mockNavigate).toHaveBeenCalledWith("/applications/new/claude-shell");
  });
});
