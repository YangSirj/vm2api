import { createFileRoute } from '@tanstack/react-router'
import { VmDetailPage } from '@/features/vm/detail-page'
import { validateVmDetailSearch } from '@/features/vm/detail-search'

export const Route = createFileRoute('/_authenticated/vm/$id')({
  validateSearch: validateVmDetailSearch,
  component: VmDetailPage,
})
