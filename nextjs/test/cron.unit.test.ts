import { isPlausibleCron } from "@/lib/cron"

describe("isPlausibleCron", () => {
  it("accepts the expressions the schedule presets use", () => {
    for (const expression of ["0 * * * *", "0 2 * * *", "0 6 * * 1-5", "*/15 * * * *"]) {
      expect(isPlausibleCron(expression)).toBe(true)
    }
  })

  it("accepts named months and weekdays", () => {
    expect(isPlausibleCron("0 0 1 JAN MON")).toBe(true)
  })

  it("requires exactly five fields", () => {
    expect(isPlausibleCron("0 2 * *")).toBe(false)
    expect(isPlausibleCron("0 2 * * * *")).toBe(false)
    expect(isPlausibleCron("")).toBe(false)
  })

  it("rejects characters that are not cron syntax", () => {
    expect(isPlausibleCron("0 2 * * *; rm -rf /")).toBe(false)
    expect(isPlausibleCron("0 2 * * $(id)")).toBe(false)
    expect(isPlausibleCron("0 2 * * '")).toBe(false)
  })

  it("rejects an absurdly long field", () => {
    expect(isPlausibleCron(`0 2 * * ${"1,".repeat(30)}`)).toBe(false)
  })

  it("tolerates extra whitespace", () => {
    expect(isPlausibleCron("  0   2  *  *  *  ")).toBe(true)
  })
})
