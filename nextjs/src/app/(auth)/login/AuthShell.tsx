import BrandMark from "@/components-v2/shared/BrandMark"
import { PRODUCT_TAGLINE } from "@/lib/branding"

/**
 * The frame both sign-in states share, so a single-user install and an SSO
 * install feel like the same product rather than two different pages.
 *
 * The backdrop is the product's own mark blown up and bled off the edge, plus
 * two soft blooms in the brand accents — the identity at scale rather than a
 * borrowed pattern.
 */
export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4 py-10 sm:py-16">
      <div aria-hidden className="auth-bloom pointer-events-none absolute inset-0" />

      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute -right-[14rem] top-1/2 h-[42rem] w-[42rem] -translate-y-1/2 -rotate-6 text-slate-900/[0.045] sm:-right-[10rem]"
      >
        <path d="M5 16.5 9.5 12l3 3L19 8.5" />
        <path d="M6 7.5h5M6 11h2.5M15.5 17H19" />
      </svg>

      <div className="auth-rise relative w-full max-w-[25.5rem]">
        <section className="rounded-2xl border border-slate-200/90 bg-white p-7 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_18px_44px_-20px_rgba(15,23,42,0.24)] sm:p-8">
          <BrandMark compact />
          <div className="mt-6">{children}</div>
        </section>

        <p className="mt-5 px-2 text-center text-xs leading-5 text-slate-500">
          {PRODUCT_TAGLINE}
        </p>
      </div>
    </main>
  )
}
