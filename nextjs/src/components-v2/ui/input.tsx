import * as React from "react"
import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-lg border border-slate-300 bg-white px-3 py-1 text-sm shadow-sm transition-[border-color,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-gray-400 focus-visible:border-[#0078D4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0078D4]/15 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-70",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
