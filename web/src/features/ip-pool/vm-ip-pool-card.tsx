import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, LockKeyhole, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/features/vm/detail-section-primitives'
import { copyPoolAccess, poolAction, poolQueryKey, readPool } from './api'
import { ConfirmPoolAction } from './confirm-action'
import {
  assignmentApplied,
  deletionLabel,
  formatAnchor,
  formatDistance,
  poolActions,
  poolManaged,
  poolOperationBusy,
  poolTargetAction,
  stateLabels,
  type IpPoolAction,
} from './model'

const actionLabels: Record<IpPoolAction, string> = {
  assign: '分配并应用',
  apply: '核对后应用',
  replace: '就近更换',
  probe: '核对出口',
  release: '释放出口',
  'login-lock': '开始登录，锁定 IP',
  'login-unlock': '已完成登录，解锁',
  blacklist: '确认封号，标黑 IP',
  'retry-deletion': '核对并重试删除',
}

const actionSuccess: Record<IpPoolAction, string> = {
  assign: '出口已分配并应用',
  apply: '已核对并应用出口',
  replace: '出口已更换',
  probe: '出口已核对',
  release: '出口已释放',
  'login-lock': 'IP 已锁定，请让登录浏览器使用复制的链接',
  'login-unlock': '登录锁已解除',
  blacklist: '已记录标黑结果',
  'retry-deletion': '已更新上游删除结果',
}

export function VmIpPoolCard({
  vmId,
  onManagedChange,
}: {
  vmId: string
  onManagedChange: (managed: boolean) => void
}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState<IpPoolAction | 'access' | null>(null)
  const actionLock = useRef(false)
  const [confirm, setConfirm] = useState<{
    kind: 'assign' | 'replace' | 'release' | 'blacklist'
    targeted?: boolean
  } | null>(null)
  const q = useQuery({
    queryKey: poolQueryKey(vmId),
    queryFn: ({ signal }) => readPool(vmId, signal),
    retry: false,
    refetchInterval: pending ? false : 5000,
    refetchOnWindowFocus: false,
  })
  const view = q.data
  const managed = Boolean(pending || !view || q.isError || poolManaged(view))
  useEffect(() => onManagedChange(managed), [managed, onManagedChange])
  const operationBusy = view ? poolOperationBusy(view) : false
  const busy = Boolean(pending || operationBusy || q.isError || !view)

  async function refreshVm() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['panel', 'vm', vmId] }),
      qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
      qc.invalidateQueries({ queryKey: ['panel', 'proxies'] }),
    ])
  }

  async function run(action: IpPoolAction, body?: Record<string, unknown>) {
    if (actionLock.current || busy || !view || !poolActions(view)[action])
      return false
    actionLock.current = true
    setPending(action)
    try {
      await qc.cancelQueries({ queryKey: poolQueryKey(vmId) })
      const result = await poolAction(vmId, action, body)
      qc.setQueryData(poolQueryKey(vmId), result)
      await refreshVm()
      if (
        result.error ||
        result.state === 'pending' ||
        result.state === 'error'
      ) {
        toast.warning(result.error?.message || '操作尚未完成，请核对后应用')
      } else if (
        result.blacklist &&
        result.blacklist.deletion_state !== 'succeeded'
      ) {
        toast.warning(deletionLabel(result.blacklist))
      } else {
        toast.success(actionSuccess[action])
      }
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '操作未完成，请刷新状态'
      )
      await q.refetch()
      return false
    } finally {
      actionLock.current = false
      setPending(null)
    }
  }

  async function copyAccess() {
    if (actionLock.current || busy || !view || !poolActions(view).access) return
    actionLock.current = true
    setPending('access')
    try {
      await qc.cancelQueries({ queryKey: poolQueryKey(vmId) })
      const expectedIp = await copyPoolAccess(vmId)
      toast.success(
        expectedIp
          ? `链接已复制，出口 ${expectedIp} 已锁定；登录完成后请点解锁`
          : '链接已复制，登录期间已锁定出口；登录完成后请点解锁'
      )
    } catch (_error) {
      toast.error(
        '复制未完成，请刷新状态后重试；若浏览器提示剪贴板权限，请允许'
      )
    } finally {
      await q.refetch()
      await refreshVm()
      actionLock.current = false
      setPending(null)
    }
  }

  if (
    view &&
    !view.configured &&
    !poolManaged(view) &&
    !q.isError &&
    !view.error
  )
    return null

  const actions = view ? poolActions(view) : null
  const locked =
    view?.state !== 'blacklisted' &&
    (view?.login_locked || view?.state === 'login_locked')
  const consistent = view ? assignmentApplied(view) : false
  const targetAction = view ? poolTargetAction(view) : null

  function actionButton(action: IpPoolAction) {
    if (!actions?.[action]) return null
    return (
      <Button
        key={action}
        size='sm'
        variant={
          action === 'assign' || action === 'apply' ? 'default' : 'outline'
        }
        disabled={busy}
        loading={pending === action}
        onClick={() => {
          if (
            action === 'replace' ||
            action === 'release' ||
            action === 'blacklist'
          )
            setConfirm({ kind: action })
          else void run(action)
        }}
      >
        {action === 'login-lock' || action === 'login-unlock' ? (
          <LockKeyhole className='size-3.5' />
        ) : null}
        {action === 'login-unlock' && view?.error
          ? '结束登录并处理出口'
          : actionLabels[action]}
      </Button>
    )
  }

  return (
    <Card>
      <CardHeader className='pb-3'>
        <div className='flex items-center justify-between gap-3'>
          <CardTitle className='text-sm'>IP 池</CardTitle>
          <div className='flex items-center gap-2'>
            {view ? (
              <span className='text-xs text-muted-foreground'>
                {stateLabels[view.state] || '状态待核对'}
              </span>
            ) : null}
            <Button
              size='sm'
              variant='ghost'
              aria-label='刷新 IP 池状态'
              disabled={Boolean(pending)}
              onClick={() => void q.refetch()}
              loading={q.isFetching && !view}
            >
              <RefreshCw className='size-3.5' />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        {q.isPending ? (
          <p className='text-sm text-muted-foreground'>正在读取 IP 池状态…</p>
        ) : null}
        {q.isError ? (
          <p
            role='alert'
            className='rounded-md border border-destructive/30 p-3 text-sm text-destructive'
          >
            暂时无法读取 IP 池状态。请刷新后再操作代理。
          </p>
        ) : null}
        {view ? (
          <>
            {view.assignment || view.applied ? (
              <div className='divide-y'>
                <Field label='IP 池已分配'>
                  <span className='font-mono'>
                    {view.assignment?.current_exit_ip || '未知'}
                  </span>
                </Field>
                <Field
                  label={
                    view.state === 'blacklisted' ? '停用前出口' : '本机已应用'
                  }
                >
                  <span className='font-mono'>
                    {view.applied?.exit_ip || '尚未应用'}
                  </span>
                  {view.applied?.exit_ip ? (
                    <span className='ml-2 text-xs text-muted-foreground'>
                      {view.state === 'blacklisted'
                        ? '账号已停用'
                        : consistent
                          ? '与分配一致'
                          : '与分配尚未核对一致'}
                    </span>
                  ) : null}
                </Field>
                <Field label='最近核对'>
                  {view.applied?.verified_at
                    ? new Date(view.applied.verified_at).toLocaleString()
                    : '未核对'}
                </Field>
                <Field label='首次位置'>
                  {formatAnchor(view.assignment?.anchor)}
                </Field>
                <Field label='距首次位置'>
                  {formatDistance(view.assignment?.distance_km_from_anchor)}
                </Field>
              </div>
            ) : (
              <p className='text-sm text-muted-foreground'>
                分配一个出口后，可以复制链接供登录浏览器使用。
              </p>
            )}
            {locked ? (
              <p role='status' className='rounded-md bg-muted p-3 text-sm'>
                登录期间已锁定
                IP。请让浏览器使用下方复制的链接，完成登录并关闭登录页面后再解锁。
              </p>
            ) : null}
            {operationBusy ? (
              <p role='status' className='text-sm text-muted-foreground'>
                正在处理，请等待当前操作完成。
              </p>
            ) : null}
            {view.state === 'pending' ? (
              <p role='status' className='rounded-md bg-muted p-3 text-sm'>
                分配结果尚未在本机确认。请使用“核对后应用”继续完成这次操作。
              </p>
            ) : null}
            {view.error ? (
              <p
                role='alert'
                className='rounded-md border border-destructive/30 p-3 text-sm text-destructive'
              >
                {view.error.message}
              </p>
            ) : null}
            {view.blacklist ? (
              <div className='rounded-md border p-3 text-sm'>
                <p>{deletionLabel(view.blacklist)}</p>
                <p className='mt-1 text-xs text-muted-foreground'>
                  {view.blacklist.deletion_state === 'succeeded'
                    ? view.blacklist.endpoint_access_revoked
                      ? '旧链接已失效。'
                      : '旧链接失效状态待核对。'
                    : '该出口已被排除，只有上游确认删除后才算清理完成。'}
                </p>
              </div>
            ) : null}
            <div className='flex flex-wrap gap-2'>
              {actionButton('assign')}
              {actionButton('apply')}
              {targetAction ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  onClick={() =>
                    setConfirm({ kind: targetAction, targeted: true })
                  }
                >
                  指定公网 IP
                </Button>
              ) : null}
              {actions?.access ? (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={busy}
                  loading={pending === 'access'}
                  onClick={() => void copyAccess()}
                >
                  <Copy className='size-3.5' />
                  复制 VLESS 链接
                </Button>
              ) : null}
              {actionButton('login-lock')}
              {actionButton('login-unlock')}
              {actionButton('probe')}
              {actionButton('replace')}
              {actionButton('release')}
              {actionButton('blacklist')}
              {actionButton('retry-deletion')}
            </div>
            {poolManaged(view) ? (
              <p className='text-xs text-muted-foreground'>
                此账号的出口由 IP
                池管理。更换出口始终参考首次位置；普通连接故障可先核对出口。
              </p>
            ) : null}
          </>
        ) : null}
      </CardContent>
      {confirm && view ? (
        <ConfirmPoolAction
          key={`${confirm.kind}:${Boolean(confirm.targeted)}`}
          kind={confirm.kind}
          targeted={confirm.targeted}
          exitIp={
            view.applied?.exit_ip || view.assignment?.current_exit_ip || ''
          }
          busy={Boolean(pending)}
          available={!busy && Boolean(actions?.[confirm.kind])}
          onClose={() => setConfirm(null)}
          onConfirm={(body) => run(confirm.kind, body)}
        />
      ) : null}
    </Card>
  )
}
