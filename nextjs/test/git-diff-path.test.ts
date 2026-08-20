import { describe, expect, it } from "vitest";
import {
  buildGitShowHeadCommand,
  normalizeGitRevisionPath,
  quoteGitRevision,
} from "../src/lib/git/diffPath";

describe("git diff path helpers", () => {
  it("keeps the full project-relative path for files in nested folders", () => {
    expect(normalizeGitRevisionPath("models/staging/orders.sql")).toBe(
      "models/staging/orders.sql"
    );
  });

  it("removes leading slashes without dropping path segments", () => {
    expect(normalizeGitRevisionPath("/models/staging/orders.sql")).toBe(
      "models/staging/orders.sql"
    );
  });

  it("quotes git revisions for shlex-split backend commands", () => {
    expect(
      buildGitShowHeadCommand("models/staging/order facts.sql")
    ).toBe("show 'HEAD:models/staging/order facts.sql'");
  });

  it("escapes single quotes in quoted revisions", () => {
    expect(quoteGitRevision("HEAD:models/owner's.sql")).toBe(
      "'HEAD:models/owner'\\''s.sql'"
    );
  });
});
