import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PoolCandidatePicker } from './candidate-picker'
import { incidentTime, localDateTime, normalizeTargetExitIp } from './model'

export function ConfirmPoolAction({
  vmId,
  kind,
  targeted = false,
  available = true,
  exitIp,
  busy,
  onClose,
  onConfirm,
}: {
  vmId: string
  kind: 'assign' | 'replace' | 'release' | 'blacklist'
  targeted?: boolean
  available?: boolean
  exitIp: string
  busy: boolean
  onClose: () => void
  onConfirm: (body?: Record<string, unknown>) => Promise<boolean>
}) {
  const [eventIp, setEventIp] = useState(exitIp)
  const [eventTime, setEventTime] = useState(() => localDateTime())
  const [incidentId] = useState(() => crypto.randomUUID())
  const [confirmed, setConfirmed] = useState(false)
  const [targetIp, setTargetIp] = useState('')
  const banning = kind === 'blacklist'
  const title = targeted
    ? '指定公网 IP'
    : banning
      ? '确认封号并标黑出口'
      : kind === 'replace'
        ? '就近更换出口'
        : '释放当前出口'
  const validTime = incidentTime(eventTime)
  const normalizedTargetIp = normalizeTargetExitIp(targetIp)
  const canConfirm =
    available &&
    confirmed &&
    (!targeted || Boolean(normalizedTargetIp)) &&
    (!banning || (Boolean(eventIp.trim()) && Boolean(validTime)))

  async function submit() {
    if (!canConfirm || busy) return
    const ok = await onConfirm(
      banning
        ? {
            confirmation: 'user_confirmed',
            incident_id: incidentId,
            exit_ip_at_event: eventIp.trim(),
            occurred_at: validTime,
            reason: 'account_banned',
          }
        : targeted
          ? { target_exit_ip: normalizedTargetIp }
          : undefined
    )
    if (ok) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className={
          targeted
            ? 'max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {targeted
              ? kind === 'replace'
                ? '当前请求结束后切换到指定的公网 IP，旧出口进入冷却期。只请求这个 IP；不可用时会显示原因。'
                : '从 IP 池分配指定的公网 IP，并核对槽内实际出口。只请求这个 IP；不可用时会显示原因。'
              : banning
                ? '确认账号被封禁后，会停止该账号，标黑出事时使用的出口，并让 IP 池删除该节点。连接超时、额度用尽和登录失败不等于封号。'
                : kind === 'replace'
                  ? '会以首次分配的位置为基准寻找最近的可用出口。当前请求结束后再切换，旧出口进入冷却期。'
                  : '当前请求结束后释放出口，旧出口进入冷却期；该账号需要重新分配出口才能继续使用。'}
          </DialogDescription>
        </DialogHeader>
        {banning ? (
          <div className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='ip-pool-event-ip'>出事时使用的公网 IP</Label>
              <Input
                id='ip-pool-event-ip'
                value={eventIp}
                disabled={busy}
                autoComplete='off'
                onChange={(event) => {
                  setEventIp(event.target.value)
                  setConfirmed(false)
                }}
              />
              <p className='text-xs text-muted-foreground'>
                已填最近核对的出口。若封号发生在换 IP 之前，请改成当时的出口。
              </p>
            </div>
            <div className='space-y-2'>
              <Label htmlFor='ip-pool-event-time'>
                发现封号的时间（本机时区）
              </Label>
              <Input
                id='ip-pool-event-time'
                type='datetime-local'
                value={eventTime}
                disabled={busy}
                max={localDateTime()}
                onChange={(event) => {
                  setEventTime(event.target.value)
                  setConfirmed(false)
                }}
              />
              {!validTime ? (
                <p className='text-xs text-destructive'>
                  请输入有效时间，不能晚于现在。
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <p className='text-sm'>
            当前出口：<span className='font-mono'>{exitIp || '未知'}</span>
          </p>
        )}
        {targeted ? (
          <PoolCandidatePicker
            vmId={vmId}
            value={normalizedTargetIp}
            currentIp={kind === 'replace' ? exitIp : ''}
            disabled={busy || !available}
            onSelect={(ip) => {
              setTargetIp(ip)
              setConfirmed(false)
            }}
          />
        ) : null}
        <label className='flex items-start gap-2 text-sm'>
          <input
            type='checkbox'
            className='mt-1'
            checked={confirmed}
            disabled={busy}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            {banning
              ? '我确认账号已封禁，并已核对出事时的 IP 和时间。'
              : kind === 'assign'
                ? '我确认将此账号分配到指定的公网 IP。'
                : '我已结束浏览器登录，关闭使用旧出口的连接。'}
          </span>
        </label>
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant={banning || kind === 'release' ? 'destructive' : 'default'}
            loading={busy}
            disabled={!canConfirm || busy}
            onClick={() => void submit()}
          >
            {banning
              ? '确认标黑并删除'
              : kind === 'assign'
                ? '确认分配并应用'
                : kind === 'replace'
                  ? '确认更换'
                  : '确认释放'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
