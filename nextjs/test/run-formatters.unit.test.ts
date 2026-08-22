import { getFullCommand } from "@/components-v2/runs/formatters"
import type { DbtRun } from "@/components-v2/runs/types"

const run = (overrides: Partial<DbtRun>): DbtRun =>
  ({ id: "r1", command: "run", selector: null, status: "success", ...overrides }) as DbtRun

describe("getFullCommand", () => {
  it("renders a plain command", () => {
    expect(getFullCommand(run({ command: "build" }))).toBe("dbt build")
  })

  it("appends the selector", () => {
    expect(getFullCommand(run({ command: "run", selector: "tag:daily+" }))).toBe(
      "dbt run --select tag:daily+",
    )
  })

  it("spells source_freshness the way dbt does", () => {
    // The enum value has an underscore; the CLI takes two words. Showing the
    // enum spelling would not match the command that actually ran.
    expect(getFullCommand(run({ command: "source_freshness" }))).toBe("dbt source freshness")
  })
})
