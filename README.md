# cf-browser-mcp

一个运行在 Cloudflare Workers 上的远程浏览器 MCP 服务。它只提供 MCP Streamable HTTP 和 OAuth 协议端点，不提供通用 REST 浏览 API。浏览器由 Cloudflare Browser Run 提供，CDP 是主要控制接口。

[MIT License](LICENSE) · [贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

根路径 `/` 和 `/source-info.json` 提供公开的机器可读项目介绍 JSON，包含源码、许可证、能力概览以及 MCP/OAuth 端点。MCP 工具的完整输入结构仍通过 OAuth 授权后的 MCP `tools/list` 提供。

## 能力

| 类别 | MCP 工具 |
| --- | --- |
| 会话与标签页 | `browser_status`、`browser_resume`、`browser_forget_saved_tab`、`browser_list_tabs`、`browser_new_tab`、`browser_activate_tab`、`browser_close_tab`、`browser_close_session`、`browser_clear_saved_state` |
| 导航与等待 | `browser_navigate`、`browser_back`、`browser_forward`、`browser_reload`、`browser_wait`、`browser_page_info` |
| 页面理解 | `browser_snapshot`、`browser_find` |
| 鼠标、键盘与表单 | `browser_click`、`browser_hover`、`browser_mouse`、`browser_scroll`、`browser_keyboard`、`browser_type`、`browser_fill`、`browser_press_key`、`browser_select_option`、`browser_check`、`browser_uncheck`、`browser_focus`、`browser_scroll_into_view`、`browser_fill_form`、`browser_handle_dialog` |
| 截图与视口 | `browser_screenshot`、`browser_set_viewport` |
| 页面代码与 CDP | `browser_evaluate`、`browser_cdp` |
| 网络与排错 | `browser_network_requests`、`browser_debug_capture` |
| 多步操作 | `browser_sequence` |
| 人工接管 | `browser_live_view`、`browser_request_human`、`browser_handoff_status`、`browser_handoff_complete` |

`browser_snapshot` 返回带 `snapshotId` 的无障碍元素引用，例如 `e4`。调用时同时传入 `ref` 和相同的 `snapshotId`；页面变化后应重新取快照。遇到多个匹配项时，工具会返回 `AMBIGUOUS_TARGET` 和候选引用，不会猜着点击。

工具通过 MCP `structuredContent` 返回页面元数据和 `durationMs`；错误结果带有稳定错误码、建议及可用的候选元素。截图作为 MCP image 内容返回。`browser_sequence` 将最多 30 步合并到一次 DO 调用和 CDP 连接中，最长 60 秒，并为每一步返回结构化结果。它不是事务，不会自动重放有副作用的动作。每步输出最多 20,000 字符，整组结果最多 80,000 字符。

JavaScript 原生弹窗会在操作结果中返回 `dialogPending`、弹窗类型和内容。此时应调用 `browser_handle_dialog` 选择接受或关闭；该工具会绕过普通操作队列，以便解除当前被挂起的页面操作。Live View 的有效期最短为 60 秒。网络调试工具支持按资源类型、URL、响应头和请求数量筛选。

## 架构与成本

- 一个 Worker 处理 MCP、OAuth 授权、令牌和发现端点。
- OAuth 令牌和授权流程记录放在一个 KV namespace；没有 D1。
- 每个 OAuth grant 有一个 Durable Object。授权时生成随机 grant 属性，通过 `SESSION_ID_SECRET` 做 HMAC 派生 DO 名称；DO 名称和 Browser Run session ID 不会返回给 MCP 客户端。不要随意轮换 `SESSION_ID_SECRET`，否则现有 grant 将无法找到之前的 DO 状态。
- DO 只在浏览器会话启动、结束或过期时更新 session ID。它没有轮询、定时 alarm 或后台心跳。
- Browser Run 首次需要页面时才启动，CDP 命令结束后立即断开。60 秒无活动后，Browser Run 可以结束远端 Chromium。
- 页面状态会在改变页面的操作后检查。只有 cookie、localStorage、HTTP(S) 标签页 URL 或视口确实变化时，才把一条状态记录写入 DO。Browser Run 结束后，下次需要浏览器的操作会恢复 cookies、localStorage、标签页 URL 和视口配置，包括移动设备模拟。
- 浏览器数据不按 agent 隔离。同一 OAuth grant 下的 agent 可以使用同一个会话；它们应各自使用 `browser_new_tab` 创建的 `tabId`。DO 会顺序执行同一会话的 MCP 操作；`browser_handle_dialog` 可以并行发送以解除原生弹窗造成的挂起。浏览器重启后目标 ID 会变化，恢复结果包含 `previousTabId` 到新 `tabId` 的映射。

恢复的是可持久化的浏览状态。页面中的 JavaScript 内存、DOM 临时状态、`sessionStorage`、IndexedDB、Service Worker 状态及正在进行的下载不会跨 Chromium 结束恢复。文件上传、下载和 PDF 文件传输不在当前版本中。

## 创建与部署

要求 Node.js 24+、npm、Wrangler 登录的 Cloudflare 账户，以及可用的 Browser Run 权限。

1. 安装依赖：

   ```sh
   npm install
   ```

2. 创建 OAuth KV namespace，并把命令返回的 ID 填入 `wrangler.jsonc` 的 `OAUTH_KV`：

   ```sh
   npx wrangler kv namespace create OAUTH_KV
   ```

3. 本地开发时复制 `.dev.vars.example` 为 `.dev.vars`，设置两个不同的随机密钥：

   ```powershell
   Copy-Item .dev.vars.example .dev.vars
   ```

   可分别运行以下命令生成密钥：

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   - `MCP_AUTH_SECRET`：OAuth 授权页要求输入的口令。
   - `SESSION_ID_SECRET`：用于派生 DO 名称的独立 HMAC 密钥。
   - `MCP_BASE_URL`：可留空，让 Worker 使用当前访问域名；正式部署建议设成唯一规范源站，例如 `https://cf-browser-mcp.example.workers.dev`。值只包含 origin，不加 `/mcp`。

4. 本地运行：

   ```sh
   npm run dev
   ```

   本地 MCP 地址是 `http://localhost:8787/mcp`。连接时客户端会打开 OAuth 授权页；只有输入 `MCP_AUTH_SECRET` 才会签发令牌。

5. 如果 MCP 客户端会通过自定义域名连接，在 `wrangler.jsonc` 的 `vars.MCP_BASE_URL` 填入该 HTTPS origin；保持空值时，服务会使用本次请求的 origin。上传生产密钥并部署：

   ```sh
   npx wrangler secret put MCP_AUTH_SECRET
   npx wrangler secret put SESSION_ID_SECRET
   npm run deploy
   ```

6. 在支持 OAuth 2.1 和 Streamable HTTP 的 MCP 客户端中添加 `https://<你的-worker-域名>/mcp`。客户端通过 MCP OAuth discovery 自动找到授权端点；在授权页面输入部署时设置的 `MCP_AUTH_SECRET`。不要把该密钥填入 MCP 客户端配置。

完成 KV namespace ID 配置后运行 `npm run types` 更新 Wrangler 绑定类型，再运行 `npm run check` 做 TypeScript 检查。

## MCP 客户端建议

向 agent 提供以下工作方式：

1. 用 `browser_status` 查看会话状态；它不启动 Chromium 或建立 CDP 连接。`tabs: null` 表示没有查询实时标签页；调用 `browser_list_tabs` 获取当前目标。若远端 session 已休眠且有可恢复标签页，调用 `browser_resume` 后再 `browser_list_tabs`。
2. 首次使用时用 `browser_navigate` 打开页面，或用 `browser_new_tab` 创建独立标签页。
3. 保存并复用当前运行期返回的 `tabId`，每次操作都显式传入，避免多个 agent 误操作同一个标签页。Chromium 重启后使用 `browser_resume` 返回的 `tabIdMappings` 更新旧 ID。
4. 用 `browser_snapshot` 或 `browser_find` 获取当前页面的角色、名称和引用，再执行操作。导航或页面大幅变化后重新取快照。
5. 优先用 `browser_fill_form` 或 `browser_sequence` 合并相关操作，减少 MCP/DO 往返。遇到未知 UI 时先截图或快照，不要盲目点击。
6. `browser_evaluate` 和 `browser_cdp` 能在已授权浏览器里执行任意页面操作；只对可信的 MCP 服务和 agent 发放授权。
7. 如需人工查看，调用 `browser_live_view`；如需人工操作，调用 `browser_request_human`，完成后检查状态并调用 `browser_handoff_complete`。Live View URL 是短时 bearer 链接，拿到链接的人可以查看该浏览器。
8. `browser_close_session` 会关闭当前 Chromium，但保留可恢复的浏览状态；要删除已保存的 cookies 和站点数据，调用 `browser_clear_saved_state`。
9. 如果 `browser_resume` 无法恢复某个损坏标签页，先用 `browser_status` 找到它的 `previousTabId`，确认会话不活跃后调用 `browser_forget_saved_tab`。它只删除该标签页的恢复记录，不启动 Chromium，也保留 cookies 和全部 localStorage。

OAuth access token 默认有效 1 小时，refresh token 最长 90 天并在活动时延长空闲期限。授权密钥失败会按来源 IP 限制尝试次数。丢失密钥后，可在 Cloudflare Workers 设置中更换 secret；已经签发的 OAuth grant 仍需要通过客户端 revoke 或重新授权管理。

## 维护说明

`@cloudflare/puppeteer` 目前固定依赖旧版 `@puppeteer/browsers`。项目通过 npm override 使用 3.2.4，移除其依赖树里的高危归档解压和 FTP 代理包；Worker 只使用 Cloudflare Browser Run，不使用本地浏览器下载功能。升级 Puppeteer 时，重新核对这个 override，并运行类型检查、Wrangler dry-run 和 `npm audit`。
