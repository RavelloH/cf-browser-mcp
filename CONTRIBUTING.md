# 贡献指南

感谢你愿意为 cf-browser-mcp 提交反馈或改进。

## 提交问题

- 使用 GitHub Issues 报告可复现的问题或提出功能建议。
- 不要在 issue、日志或截图中发布 OAuth token、授权密钥、Cookie、浏览器会话数据或个人信息。
- 安全漏洞请按 [安全政策](SECURITY.md) 私下报告，不要创建公开 issue。

## 提交代码

1. Fork 仓库并从 `main` 创建分支。
2. 保持改动范围清晰；涉及工具行为时同步更新 README 中的能力说明和输入约定。
3. 本地安装依赖并运行静态检查：

   ```sh
   npm ci
   npm run types
   npm run check
   npm audit
   npx wrangler deploy --dry-run
   ```

4. 提交 Pull Request，说明问题背景、改动内容和验证结果。

不要在 PR 中加入 `.dev.vars`、真实 Cloudflare 资源 ID、部署日志中的凭据或浏览器持久化数据。不要提交 `node_modules` 或 `.wrangler` 目录。
