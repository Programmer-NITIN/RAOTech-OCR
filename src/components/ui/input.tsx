import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-border h-10 w-full min-w-0 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs transition-all outline-none file:inline-flex file:h-7 file:border-0 file:bg-secondary file:text-secondary-foreground file:px-3 file:py-1 file:rounded-md file:mr-3 file:text-xs file:font-semibold file:cursor-pointer hover:file:bg-accent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
