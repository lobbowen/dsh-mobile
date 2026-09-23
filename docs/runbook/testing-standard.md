# 测试规范（TESTING-STANDARD）

- 状态：v1 · 2026-09-23
- 红线：**本地禁止任何测试执行**。本项目是公开发行产品，唯一合法的验证通道是 **GitHub Actions**。

---

## 1. 为什么

本机（Android/bionic、`/tmp` 只读、无 Android SDK/JDK/Gradle）与 CI runner 不是同一环境：
本地跑出来的"绿"或"红"都**不代表**发布环境，只会制造错误信心，并消耗时间。
真实验证必须以 CI 构建产物为准。

## 2. 红线（禁止事项）

**禁止**在本地执行任何会对被测代码求值的命令，包括但不限于：

- `node test/*.js`、`node --check`、`npm test` / `npm run *`
- `./gradlew *`、`gradle`、任何编译/打包
- 直接执行仓库内脚本（`scripts/*.sh`、`*.py`、`container/engine/bin/*`）做自检
- 任何形式的"我先本地试一下"

## 3. 允许的本地操作（白名单）

- 编辑文件（write/edit）
- 只读检查：`read` / `grep` / `glob` / `ls` / 统计
- `git` 级别的提交与推送（本仓由 API 代执行）
- **对账的"报告模式"**（只列事实、不做断言）——它不是测试

> 判据：**是否让被测代码运行**。跑代码 = 违规；只看文件 = 允许。

## 4. 唯一合法验证通道

```
编辑 → 提交 → 推分支 → 触发 CI（main/master 推送，或 fast-* tag）→ 读 CI 结果 → 修复 → 再推
```

读取 CI 结果的两条通道：

1. **API**（本会话使用）：`GET /actions/runs/{id}`、`/jobs`、`/jobs/{job_id}/logs`
2. **admin 回执通道**（沙箱无法直连 API 时）：`git push origin HEAD:refs/tags/admin-<cmd> …`，结果写 `ci-admin` 分支

## 5. 门禁归属

所有门禁（对账 `layout-manifest-test`、`dead-path-gate`、原生资产一致性、桥协议、OTA）**只作为 CI 步骤存在**，
本地不得单独调用。它们已被接入 `container/engine/package.json` 的 `test:logic`（CI 执行）。

## 6. 违规记录

| 日期 | 违规 | 处置 |
|---|---|---|
| 2026-09-23 | 本地执行引擎测试（`node test/*.js`）做验证 | 停止；本规范确立；本地测试工具（`_tools/bin/node`）删除 |
