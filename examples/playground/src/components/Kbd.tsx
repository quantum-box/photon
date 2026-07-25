import type { ComponentProps } from 'react'

type KbdProps = ComponentProps<'kbd'>
type KbdGroupProps = ComponentProps<'span'>

export function Kbd({ className = '', ...props }: KbdProps) {
  return (
    <kbd
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-canvas px-1.5 font-mono text-[11px] font-medium leading-none text-muted shadow-[inset_0_-1px_0_var(--border-color)] ${className}`}
      {...props}
    />
  )
}

export function KbdGroup({ className = '', ...props }: KbdGroupProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 align-middle ${className}`}
      {...props}
    />
  )
}
