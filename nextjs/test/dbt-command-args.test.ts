import { describe, expect, it } from "vitest";
import {
  buildDbtAdditionalArgs,
  buildDbtCommandWithArgs,
} from "../src/lib/dbt-command-args";

describe("dbt command args", () => {
  it("keeps vars args intact", () => {
    expect(buildDbtAdditionalArgs("show", `--vars '{"branch_id": 10}'`, false)).toBe(
      `--vars '{"branch_id": 10}'`,
    );
  });

  it("keeps full-refresh from typed args for preview and compile", () => {
    expect(buildDbtAdditionalArgs("show", `--full-refresh --vars '{"branch_id": 10}'`, false)).toBe(
      `--full-refresh --vars '{"branch_id": 10}'`,
    );
    expect(buildDbtAdditionalArgs("compile", `--vars '{"branch_id": 10}' -f`, false)).toBe(
      `--vars '{"branch_id": 10}' -f`,
    );
  });

  it("applies full-refresh checkbox to preview, run, and compile", () => {
    expect(buildDbtCommandWithArgs("run --select orders", "", true)).toBe(
      "run --select orders --full-refresh",
    );
    expect(buildDbtCommandWithArgs("show --select orders", "", true)).toBe(
      "show --select orders --full-refresh",
    );
    expect(buildDbtCommandWithArgs("compile --select orders", "", true)).toBe(
      "compile --select orders --full-refresh",
    );
  });

  it("appends args to supported dbt commands", () => {
    expect(
      buildDbtCommandWithArgs("run --select orders", `--vars '{"branch_id": 10}'`, false),
    ).toBe(`run --select orders --vars '{"branch_id": 10}'`);
    expect(
      buildDbtCommandWithArgs("show --select orders", `--full-refresh --vars '{"branch_id": 10}'`, false),
    ).toBe(`show --select orders --full-refresh --vars '{"branch_id": 10}'`);
  });

  it("does not duplicate full-refresh from checkbox", () => {
    expect(buildDbtCommandWithArgs("show --select orders", "--full-refresh", true)).toBe(
      "show --select orders --full-refresh",
    );
  });
});
