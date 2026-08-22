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

describe("buildDbtCommandWithArgs with a target", () => {
  it("appends the selected target", () => {
    expect(buildDbtCommandWithArgs("run", "", false, "prod")).toBe("run --target prod")
  })

  it("appends after extra args, not before them", () => {
    expect(buildDbtCommandWithArgs("run", "--vars '{}'", false, "prod")).toBe(
      "run --vars '{}' --target prod",
    )
  })

  it("leaves an explicit --target in the command alone", () => {
    expect(buildDbtCommandWithArgs("run --target staging", "", false, "prod")).toBe(
      "run --target staging",
    )
    expect(buildDbtCommandWithArgs("run -t staging", "", false, "prod")).toBe(
      "run -t staging",
    )
    expect(buildDbtCommandWithArgs("run --target=staging", "", false, "prod")).toBe(
      "run --target=staging",
    )
  })

  it("ignores no target and the default empty values", () => {
    expect(buildDbtCommandWithArgs("run", "", false)).toBe("run")
    expect(buildDbtCommandWithArgs("run", "", false, null)).toBe("run")
    expect(buildDbtCommandWithArgs("run", "", false, "  ")).toBe("run")
  })

  it("drops a target name that is not a valid identifier", () => {
    // It would reach the dbt CLI as an argument; a bad name is dropped, not sent.
    expect(buildDbtCommandWithArgs("run", "", false, "prod; rm -rf /")).toBe("run")
    expect(buildDbtCommandWithArgs("run", "", false, "PROD")).toBe("run")
    expect(buildDbtCommandWithArgs("run", "", false, "--profiles-dir")).toBe("run")
  })

  it("applies to commands that take no extra args", () => {
    expect(buildDbtCommandWithArgs("test", "--vars x", false, "prod")).toBe(
      "test --target prod",
    )
    expect(buildDbtCommandWithArgs("source freshness", "", false, "prod")).toBe(
      "source freshness --target prod",
    )
  })
})
