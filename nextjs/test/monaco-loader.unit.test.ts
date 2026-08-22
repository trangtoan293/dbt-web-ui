import { configureMonacoLoader } from "@/lib/monaco-loader"
import { createSecurityHeaders } from "../next.config"

describe("local Monaco loader", () => {
  it("provides the installed Monaco module instead of the default CDN path", () => {
    const config = vi.fn()
    const monaco = { editor: {} }

    configureMonacoLoader({ config }, monaco)

    expect(config).toHaveBeenCalledOnce()
    expect(config).toHaveBeenCalledWith({ monaco })
  })

  it("keeps the script policy self-hosted", () => {
    const contentSecurityPolicy = createSecurityHeaders(true).find(
      ({ key }) => key === "Content-Security-Policy"
    )?.value

    expect(contentSecurityPolicy).toContain("script-src 'self'")
    expect(contentSecurityPolicy).not.toContain("cdn.jsdelivr.net")
  })
})
