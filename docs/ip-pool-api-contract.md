# IP 池接口契约

本适配基于 2026-10-21 已联调的 xray-biz `1.1-lite`。相同版本号已有能力增量，升级时以 `GET /api/v1/capabilities` 的 `features` 为准。本目录不保存 API Key、VLESS 链接或账号凭据。

## 客户端约定

`IpPoolClient({ baseUrl, keyFile, fetchImpl = fetch, timeoutMs = 60000 })` 只接受 HTTPS。`baseUrl` 可为站点根地址或以 `/api/v1` 结尾。每次请求重新读取后端私有 `keyFile`，使用 `Authorization: Bearer`，禁止重定向，不关闭证书校验，也不自动重试。

成功响应为 `{ ok: true, request_id, data, next_cursor? }`。`request(method, path, body)` 与 `events(after)` 返回完整响应；其余便捷方法返回 `data`。`request` 的路径相对于 `/api/v1`。`listAssignments(consumerRef)` 返回一页数据；按账号唯一标识查询足够，完整库存对账需用 `request` 保留 `next_cursor` 并翻页。

`IpPoolError` 暴露固定中文 `message` 及 `code/status/retryable/outcomeUnknown`，不保留上游原始消息、响应体或异常 cause。超时、网络中断、无效响应与服务端错误可能发生在写操作生效之后，`outcomeUnknown=true` 时先查询现状和历史，不能直接再次换绑。`retryable` 仅转述服务端建议，不触发自动重试。

## 已使用的接口

| 方法 | 路径                             | 请求与响应要点                                                                                                                                                 |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/capabilities`                  | `api_version, client_id, features, events, limits`                                                                                                             |
| GET  | `/assignments?consumer_ref=...`  | `data.assignments[]`                                                                                                                                           |
| GET  | `/assignments/{id}`              | `data` 直接是分配对象                                                                                                                                          |
| POST | `/candidates`                    | 只读预览；`assignment_id?, policy?, require_new_exit_ip?, exclude_proxy_ids?, limit?`，每次最多 50 条；返回 `candidates, eligible_count`                       |
| POST | `/assignments`                   | `consumer_ref, consumer_label?, anchor_ip?/anchor?, policy?`；返回 `{assignment, created, selection?}`                                                         |
| POST | `/assignments/{id}/access`       | `expected_version`；返回 `version, proxy_id, expected_exit_ip, fields, uri`                                                                                    |
| POST | `/assignments/{id}/replacements` | `expected_version, reason?, proxy_id?, require_new_exit_ip?, exclude_proxy_ids?, exclude_exit_ips?`；返回 `{assignment, previous, selection}`，随后另取 access |
| POST | `/assignments/{id}/release`      | `expected_version, reason?`；返回 `{assignment}`                                                                                                               |
| POST | `/assignments/{id}/settle`       | 无必填体；返回 `settled, settled_exit_ips?, rotated?, rotated_proxy_ids?, skipped?`                                                                            |
| GET  | `/events?after=...`              | `data.events[]` 与外层 `next_cursor`                                                                                                                           |
| POST | `/blacklist`                     | `confirmation, exit_ip_at_event, incident_id`，可附分配、版本和事件证据                                                                                        |
| GET  | `/blacklist/{id}`                | 黑名单状态对象                                                                                                                                                 |
| POST | `/blacklist/{id}/retry-deletion` | 返回更新后的黑名单状态                                                                                                                                         |

分配对象的关键字段为 `assignment_id, consumer_ref, state, hold, version, current_proxy_id, current_exit_ip, anchor, policy`。`state` 为 `active/paused/released`。服务器的 active 只表示已分配，不能据此判断 vm2api 已应用或可调度。

## 面板候选预览

管理员可查询 `GET /api/panel/ip-pool/vms/{vmId}/candidates`，返回 `{ok:true,data:{candidates,complete,fetched_at}}`，并使用 `Cache-Control: no-store`。候选只含 `proxy_id, exit_ip, country_code, region, city, distance_km, quality_score, latency_ms, health_status` 元数据，不返回连接凭据。

服务按账号分配上下文查询上游候选，每页排除已读节点，按公网 IP 去重。`complete=true` 表示已遍历此次查询中的候选，`false` 表示部分结果；查询过程不具备库存快照或预留语义。真正分配仍由上游原子检查目标资格。此 POST 是只读查询，失败不会被记作未决写操作，也不会改变账号暂停或本地分配状态。

## 版本与幂等

- 同账号始终使用同一 `consumer_ref`。未释放的分配重复创建会返回原对象，不改 policy 或锚点；释放后再创建会保留锚点并增加版本。
- 新账号不传示例锚点，首次分配自动建立。建议 `policy.exclusive_exit=true`；`same_country_required` 默认 true。近邻排序以固定锚点为基准。
- `expected_version` 用于换绑、释放和获取当前连接资料。409 `VERSION_CONFLICT` 先重新查询，不自动更新版本后再执行。
- 上游不支持 `Idempotency-Key`，`X-Request-ID` 只用于日志关联。释放也先校验版本，旧版本重发可能返回409，即使此前已释放成功。
- 没有上游 pause/resume、登录锁或 holds API。本地必须保存原调度状态、暂停排空、锁住登录期间的出口，失败时保留暂停。

## 切换与回收

检查 `features.settle=true`、`credential_rotation="on_reclaim"`。换绑或释放后旧出口进入冷却，`policy.settle_grace_seconds` 默认900，范围60–86400。新候选会排除 `settling` 出口。旧连接完全停止后才调用 settle；`settled=false` 表示无待回收出口，属于正常结果，部分字段可能缺省。`skipped` 表示其他分配仍在使用旧出口。

实际流程：暂停新请求并排空 → 换绑 → 取新 access → 更新本机代理 → 从实际槽位核验出口 → 按本地条件恢复 → 结束旧连接后 settle。上游冷却不能替代本机排空。

`access.credential_version` 在已核对版本固定为1，`login_hold` 固定false，不能用它们判断凭据是否轮换或登录是否锁定。access 中的 `uri` 和 `fields.uuid` 必须作为凭据处理。原始旧文档中“无凭据轮换”和“旧节点删除前链接始终有效”的描述已过时。

## 标黑与事件

标黑必须有 `confirmation=user_confirmed` 或 `explicit_account_ban`，并记录事件发生时的真实 `exit_ip_at_event`。不要用换绑后的当前出口。相同出口和 `incident_id` 用于去重。封禁账号继续停用，不自动换出口恢复。

只有 `deletion_state=succeeded` 才能宣告删除完成；`pending/failed/unverified` 均未确认删除。保留 `endpoint_access_revoked, inventory_removed, removed_proxies[].deleted, deleted_at, retryable, last_sync_error`。HTTP200或标黑成功不等于运行中的旧凭据已撤销。

事件每30–60秒轮询，处理后持久化游标，按 `event_id` 去重。410 `CURSOR_EXPIRED` 时先拉取分配和黑名单快照对账，再从0开始。出口自行变化和分配被暂停不增加版本，因此不能只按 `entity_version` 丢弃事件。新增事件包括 `egress.quarantined`、`egress.settled`、`proxy.credential_rotated`、`blacklist.deletion_failed`。
