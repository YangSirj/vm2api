import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const MESSAGES = {
  INVALID_ARGUMENT: 'IP 池请求参数不正确。',
  UNAUTHENTICATED: 'IP 池鉴权失败，请检查授权。',
  NOT_FOUND: 'IP 池记录不存在或无权访问。',
  VERSION_CONFLICT: 'IP 分配已发生变化，请重新查询后再操作。',
  INVALID_STATE: 'IP 分配当前状态不允许此操作。',
  EGRESS_BLACKLISTED: '此出口已被标黑。',
  NO_ELIGIBLE_PROXY: '暂无符合条件的可用出口。',
  CANDIDATE_INELIGIBLE: '所选出口当前不可分配，可能已被占用、冷却、失效或不符合分配策略。',
  CURSOR_EXPIRED: 'IP 池事件游标已过期，需要重新对账。',
  GEO_UNKNOWN: '无法确定出口位置。',
  UNSUPPORTED_PROTOCOL: 'IP 池不支持所选协议。',
  VANTAGE_UNAVAILABLE: 'IP 池不支持所选测试位置。',
  BAN_CONFIRMATION_REQUIRED: '标黑前需要确认封禁事实。',
  BAN_EGRESS_UNRESOLVED: '无法确定事件发生时的出口。',
  INTERNAL: 'IP 池服务发生错误，请先核对操作结果。',
  NOT_SUPPORTED: 'IP 池暂不支持此操作。',
  CONFIGURATION_ERROR: 'IP 池客户端配置不正确。',
  KEY_UNAVAILABLE: '无法读取有效的 IP 池授权文件。',
  TIMEOUT: 'IP 池请求超时，操作结果待核对。',
  NETWORK_ERROR: 'IP 池连接失败，操作结果待核对。',
  INVALID_RESPONSE: 'IP 池返回内容无效，操作结果待核对。',
  UPSTREAM_ERROR: 'IP 池请求失败，请核对操作结果。',
}

const UPSTREAM_CODES = new Set([
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'INVALID_STATE',
  'EGRESS_BLACKLISTED',
  'NO_ELIGIBLE_PROXY',
  'CANDIDATE_INELIGIBLE',
  'CURSOR_EXPIRED',
  'GEO_UNKNOWN',
  'UNSUPPORTED_PROTOCOL',
  'VANTAGE_UNAVAILABLE',
  'BAN_CONFIRMATION_REQUIRED',
  'BAN_EGRESS_UNRESOLVED',
  'INTERNAL',
  'NOT_SUPPORTED',
])

export class IpPoolError extends Error {
  constructor(code, { status = 0, retryable = false, outcomeUnknown = false } = {}) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'UPSTREAM_ERROR'
    super(MESSAGES[safeCode])
    this.name = 'IpPoolError'
    this.code = safeCode
    this.status = status
    this.retryable = retryable === true
    this.outcomeUnknown = outcomeUnknown === true
  }
}

function resourceId(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[0-9]+$`).test(value)) {
    throw new IpPoolError('INVALID_ARGUMENT')
  }
  return value
}

export class IpPoolClient {
  #baseUrl
  #keyFile
  #fetch
  #timeoutMs

  constructor({ baseUrl, keyFile, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
    let url
    try {
      url = new URL(baseUrl)
    } catch {
      throw new IpPoolError('CONFIGURATION_ERROR')
    }
    const pathname = url.pathname.replace(/\/+$/, '')
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/api/v1'].includes(pathname) ||
      typeof keyFile !== 'string' ||
      !keyFile ||
      typeof fetchImpl !== 'function' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new IpPoolError('CONFIGURATION_ERROR')
    }
    this.#baseUrl = `${url.origin}/api/v1`
    this.#keyFile = keyFile
    this.#fetch = fetchImpl
    this.#timeoutMs = timeoutMs
  }

  async request(method, path, body) {
    if (!['GET', 'POST', 'PUT'].includes(method) || typeof path !== 'string' || !path.startsWith('/')) {
      throw new IpPoolError('INVALID_ARGUMENT')
    }
    let url
    let encodedBody
    try {
      url = new URL(this.#baseUrl + path)
      if (path.startsWith('//') || path.includes('\\') || url.hash || !url.pathname.startsWith('/api/v1/')) {
        throw new Error('invalid API path')
      }
      if (body !== undefined) encodedBody = JSON.stringify(body)
    } catch {
      throw new IpPoolError('INVALID_ARGUMENT')
    }

    let key
    try {
      const contents = await readFile(this.#keyFile, 'utf8')
      const keys = new Set(contents.match(/xb_[A-Za-z0-9_-]+/g) || [])
      if (keys.size !== 1) throw new Error('invalid key file')
      key = keys.values().next().value
    } catch {
      throw new IpPoolError('KEY_UNAVAILABLE')
    }

    const mutation = method !== 'GET'
    const controller = new AbortController()
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new IpPoolError('TIMEOUT', { outcomeUnknown: mutation }))
      }, this.#timeoutMs)
    })
    const operation = async () => {
      const response = await this.#fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Request-ID': `req_${randomUUID()}`,
        },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        redirect: 'error',
        signal: controller.signal,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new IpPoolError('INVALID_RESPONSE', { status: response.status, outcomeUnknown: mutation })
      }
      if (!response.ok || payload?.ok === false) {
        const code = UPSTREAM_CODES.has(payload?.error?.code) ? payload.error.code : 'UPSTREAM_ERROR'
        throw new IpPoolError(code, {
          status: response.status,
          retryable: payload?.error?.retryable === true,
          outcomeUnknown: mutation && (response.status >= 500 || response.ok),
        })
      }
      if (payload?.ok !== true || !Object.hasOwn(payload, 'data')) {
        throw new IpPoolError('INVALID_RESPONSE', { status: response.status, outcomeUnknown: mutation })
      }
      return payload
    }
    try {
      return await Promise.race([operation(), deadline])
    } catch (error) {
      if (error instanceof IpPoolError) throw error
      throw new IpPoolError('NETWORK_ERROR', { outcomeUnknown: mutation })
    } finally {
      clearTimeout(timer)
    }
  }

  async capabilities() {
    return (await this.request('GET', '/capabilities')).data
  }

  async listAssignments(consumerRef) {
    const query = consumerRef === undefined ? '' : `?${new URLSearchParams({ consumer_ref: consumerRef })}`
    return (await this.request('GET', `/assignments${query}`)).data
  }

  async getAssignment(id) {
    return (await this.request('GET', `/assignments/${resourceId(id, 'asg')}`)).data
  }

  async assign(body) {
    return (await this.request('POST', '/assignments', body)).data
  }

  async access(id, version) {
    return (await this.request('POST', `/assignments/${resourceId(id, 'asg')}/access`, { expected_version: version }))
      .data
  }

  async replace(id, body) {
    return (await this.request('POST', `/assignments/${resourceId(id, 'asg')}/replacements`, body)).data
  }

  async settle(id) {
    return (await this.request('POST', `/assignments/${resourceId(id, 'asg')}/settle`)).data
  }

  async release(id, body) {
    return (await this.request('POST', `/assignments/${resourceId(id, 'asg')}/release`, body)).data
  }

  async events(after = 0) {
    return this.request('GET', `/events?${new URLSearchParams({ after })}`)
  }

  async blacklist(body) {
    return (await this.request('POST', '/blacklist', body)).data
  }

  async getBlacklist(id) {
    return (await this.request('GET', `/blacklist/${resourceId(id, 'bl')}`)).data
  }

  async retryDeletion(id) {
    return (await this.request('POST', `/blacklist/${resourceId(id, 'bl')}/retry-deletion`)).data
  }
}
