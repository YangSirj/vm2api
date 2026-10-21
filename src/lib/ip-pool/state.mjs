import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const stateError = () => Object.assign(new Error('无法读写 IP 池本地状态。'), { code: 'STATE_UNAVAILABLE' })

export function loadIpPoolState(file) {
  try {
    if (!fs.existsSync(file)) return { schema_version: 1, event_cursor: '0', auth_paused: false, vms: {} }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.schema_version !== 1 || !data.vms || typeof data.vms !== 'object' || Array.isArray(data.vms)) {
      throw stateError()
    }
    return data
  } catch {
    throw stateError()
  }
}

export function saveIpPoolState(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } catch {
    throw stateError()
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try {
      fs.unlinkSync(temporary)
    } catch {}
  }
}
