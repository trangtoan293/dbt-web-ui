import { PRODUCT_NAME } from "@/lib/branding";

interface BrandMarkProps {
  compact?: boolean;
  className?: string;
  inverse?: boolean;
}

export default function BrandMark({ compact = false, className = "", inverse = false }: BrandMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-[#0078d4] shadow-sm">
        <span className="absolute -bottom-2 -right-1 h-6 w-7 rotate-[-18deg] rounded-full bg-[#0f9f9a]" />
        <svg viewBox="0 0 24 24" aria-hidden="true" className="relative h-5 w-5 fill-none stroke-white" strokeWidth="2">
          <path d="M5 16.5 9.5 12l3 3L19 8.5" />
          <path d="M6 7.5h5M6 11h2.5M15.5 17H19" />
        </svg>
      </span>
      {!compact && (
        <span className={`text-lg font-semibold tracking-tight ${inverse ? "text-white" : "text-slate-900"}`}>
          {PRODUCT_NAME}
        </span>
      )}
    </span>
  );
}
