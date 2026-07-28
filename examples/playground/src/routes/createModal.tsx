import { createContext, useContext } from 'react'

export const CreateModalContext = createContext<{
  open: boolean
  setOpen: (v: boolean) => void
}>({ open: false, setOpen: () => {} })

export function useCreateModal() {
  return useContext(CreateModalContext)
}
