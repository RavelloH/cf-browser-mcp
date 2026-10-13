# 安全政策

cf-browser-mcp 可以在已授权的 Cloudflare Browser 会话中执行页面 JavaScript 和原始 CDP 命令，也可能持久化浏览器 Cookie 与站点数据。请只部署在你控制的 Cloudflare 账户中，并妥善保管 OAuth 授权密钥、`SESSION_ID_SECRET` 和已签发的访问令牌。

## 支持版本

目前支持 `main` 分支的最新提交。尚未建立旧版本的安全维护周期。

## 报告漏洞

请使用 GitHub 仓库的 **Security → Report a vulnerability** 提交私密漏洞报告。请提供受影响版本、复现步骤、影响范围，以及建议的修复方式。不要通过公开 issue、讨论或提交记录披露尚未修复的漏洞，也不要附上真实 token、Cookie 或站点数据。

如果 GitHub 私密漏洞报告入口暂时不可用，请先通过仓库 issue 请求私下联系；不要在公开 issue 中写入漏洞细节。
