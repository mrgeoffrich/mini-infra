import { describe, it, expect } from "vitest";
import { extractGoogleDriveFolderId } from "./folder-id-utils";

describe("extractGoogleDriveFolderId", () => {
  it("returns a bare folder id unchanged", () => {
    expect(extractGoogleDriveFolderId("1A2B3C4D5E6F7G8H9I")).toBe(
      "1A2B3C4D5E6F7G8H9I",
    );
  });

  it("trims whitespace around a bare id", () => {
    expect(extractGoogleDriveFolderId("  1A2B3C4D5E6F7G8H9I  ")).toBe(
      "1A2B3C4D5E6F7G8H9I",
    );
  });

  it("extracts the id from a standard /drive/folders/<id> URL", () => {
    expect(
      extractGoogleDriveFolderId(
        "https://drive.google.com/drive/folders/1A2B3C4D5E6F7G8H9I",
      ),
    ).toBe("1A2B3C4D5E6F7G8H9I");
  });

  it("extracts the id from a /drive/u/0/folders/<id> URL", () => {
    expect(
      extractGoogleDriveFolderId(
        "https://drive.google.com/drive/u/0/folders/1A2B3C4D5E6F7G8H9I",
      ),
    ).toBe("1A2B3C4D5E6F7G8H9I");
  });

  it("extracts the id when the URL has trailing query params", () => {
    expect(
      extractGoogleDriveFolderId(
        "https://drive.google.com/drive/folders/1A2B3C4D5E6F7G8H9I?usp=sharing",
      ),
    ).toBe("1A2B3C4D5E6F7G8H9I");
  });

  it("returns null for an empty string", () => {
    expect(extractGoogleDriveFolderId("")).toBeNull();
    expect(extractGoogleDriveFolderId("   ")).toBeNull();
  });

  it("returns null for an unrelated URL", () => {
    expect(
      extractGoogleDriveFolderId("https://example.com/some/path"),
    ).toBeNull();
  });

  it("returns null for an id that is too short", () => {
    expect(extractGoogleDriveFolderId("abc123")).toBeNull();
  });
});
