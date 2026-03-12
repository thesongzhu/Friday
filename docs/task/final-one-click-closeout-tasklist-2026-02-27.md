> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday 最后阶段一键收尾任务单（2026-02-27）

目标：把 Friday 收敛到“可开源发布”终态，满足：能装、能跑、文档清晰、CI 可靠、可发布、可维护，并对齐蓝图闭环。

## 一键收尾总入口（定义）

建议把最终收尾统一成一个命令（任务项 `BOOT-001`）：

```bash
npm run closeout:final
```

建议链路（供 `closeout:final` 编排）：

```bash
npm ci \
&& npm run typecheck \
&& npm run lint \
&& npm run build \
&& npm test \
&& npm run test:contracts \
&& npm run test:install:smoke \
&& npm run demo:minimal \
&& npm run release:check
```

---

## P0（发布阻断，必须完成）

| ID | 主题 | 任务 | 涉及文件 | 执行/验证命令 | 验收标准 | 回滚点 |
|---|---|---|---|---|---|---|
| BOOT-001 | 一键收尾 | 新增 `closeout:final` 脚本，把发布前必需门禁串成一条命令 | `package.json` | `npm run closeout:final` | 本地一次命令可跑完所有发布门禁并退出 0 | 删除新增 script，恢复原脚本 |
| BOOT-002 | 收尾报告 | 生成 machine-readable 收尾报告（JSON/MD），记录版本、提交、测试摘要、跳过测试数 | `scripts/quality/*`、`docs/reports/release-readiness-*` | `npm run closeout:final` 后检查报告产物 | 每次收尾都有可追溯报告文件 | 回退新增报告脚本 |
| RUN-001 | 能装 | 冷启动安装路径验证（macOS/Linux/Windows） | `.github/workflows/ci.yml`、`scripts/ci/install-smoke.mjs` | CI matrix + `npm run test:install:smoke` | 三平台安装、启动、`friday --help` 全绿 | 还原 matrix 或 smoke 脚本变更 |
| RUN-002 | 能跑 | 最小 demo 工作流一条命令可跑通 | `scripts/demo/minimal-workflow-demo.mjs`、`examples/workflows/*` | `npm run demo:minimal` | 0 配置或最小配置可完成一次端到端示例 | 回退 demo 脚本或示例 |
| DOC-001 | 快速开始 | README 的 5 分钟上手路径（安装、启动、调用、停止）完整闭环 | `README.md` | 按 README 从空目录实操 | 新用户无需外部资料即可跑通 | 回退 README 变更 |
| DOC-002 | 自救文档 | FAQ/常见错误/日志位置/debug 开关全部可执行 | `docs/TROUBLESHOOTING.md`、`README.md` | 按文档触发 2-3 个常见错误并恢复 | 文档给出明确日志路径与 debug 方法 | 回退故障排查章节 |
| CI-001 | CI 强门禁 | `main` 必须绿：typecheck/lint/test/contracts/install-smoke/release-check | `.github/workflows/ci.yml` | PR + main workflow | 所有 required checks 为通过 | 回退 CI job 变更 |
| REL-001 | 可发布 | 版本号/CHANGELOG/release notes 模板/RELEASING 流程对齐 | `package.json`、`CHANGELOG.md`、`docs/RELEASING.md`、`docs/RELEASE_NOTES_TEMPLATE.md` | `npm run release:check` + 人工走一遍 `docs/RELEASING.md` | 文档流程与脚本一致；可 dry-run 发版 | 回退发布文档改动 |
| SEC-001 | 安全基线 | 依赖审计、密钥扫描、SECURITY policy 完整，CI 中可执行 | `.github/workflows/ci.yml`、`SECURITY.md`、`scripts/quality/*` | `npm audit --omit=dev`、CI secrets scan | 无未记录高危；响应流程明确 | 回退安全门禁并记录例外 |
| LEG-001 | 合规 | License、版权声明、第三方依赖合规说明齐全 | `LICENSE`、`README.md`、`NOTICE`(如需) | 人工审阅 + release checklist | 发布包内许可证文件完整 | 回退许可证相关变更 |

---

## P1（强烈建议，显著提升可维护性）

| ID | 主题 | 任务 | 涉及文件 | 执行/验证命令 | 验收标准 | 回滚点 |
|---|---|---|---|---|---|---|
| EXT-001 | 可扩展规范 | 明确插件/skills/workflows 目录约定、命名规范、生命周期 | `docs/EXTENDING.md`、`examples/templates/*` | 文档审阅 + 新建模板演练 | 第三方按模板可创建可运行扩展 | 回退扩展规范文档 |
| EXT-002 | 模板可用性 | 提供最小插件模板、skill 模板、workflow 模板 | `examples/templates/*` | 复制模板后 `npm run build` | 模板可通过构建且能被加载 | 回退模板文件 |
| EXT-003 | 开发指南 | 贡献者开发环境、调试、测试分层、提交流程 | `CONTRIBUTING.md` | 新贡献者按文档完成一次 PR | 文档覆盖 setup->test->PR 全流程 | 回退贡献指南 |
| OBS-001 | 可观测性 | 统一日志等级/结构化字段/requestId 约定 | `README.md`、`docs/TROUBLESHOOTING.md`、源码日志点 | e2e 观察日志输出 | 日志可用于定位问题，不依赖猜测 | 回退日志格式约定 |
| OBS-002 | 运行健康 | 健康检查、版本端点、构建信息暴露与文档一致 | `src/api/http/routes/*`、`README.md` | `curl /health`、`curl /version` | 文档与实际返回一致 | 回退路由或文档 |
| CI-002 | 稳定性治理 | Flaky test 标注/阈值/周审计流程固化 | `.github/workflows/weekly-audit.yml`、`scripts/quality/*` | 周期审计工作流 | 跳过测试数量可度量并下降 | 回退周审计策略 |
| CI-003 | 依赖缓存优化 | Node modules/cache key 优化，缩短 CI 时长 | `.github/workflows/*.yml` | 对比前后 CI 时长 | 门禁不降级前提下耗时下降 | 回退缓存策略 |
| REL-002 | 预发布演练 | 每次版本前执行“发布彩排”（不真正 publish） | `docs/RELEASING.md`、`release.yml` | tag dry-run / workflow dispatch | 彩排可发现问题并阻断正式发布 | 回退 release workflow 变更 |
| REL-003 | 变更沟通 | release notes 模板包含 breaking change、迁移步骤、回滚说明 | `docs/RELEASE_NOTES_TEMPLATE.md` | 使用模板生成一次样例 | 用户可据文档完成升级/回滚 | 回退模板改动 |
| MAINT-001 | 代码健康 | 未使用模块/别名/导出定期清理策略 | `scripts/quality/*`、`docs/*` | `npm run check:all` | 冗余持续可见、可追踪关闭 | 回退清理规则 |

---

## P2（锦上添花，提升生态与长期运营）

| ID | 主题 | 任务 | 涉及文件 | 执行/验证命令 | 验收标准 | 回滚点 |
|---|---|---|---|---|---|---|
| COM-001 | 社区治理 | issue/PR 模板、CODEOWNERS、行为准则 | `.github/*`、`CODE_OF_CONDUCT.md` | 创建 issue/PR 试运行 | 社区协作流程标准化 | 回退模板/规则 |
| COM-002 | 支持边界 | 明确支持矩阵（Node 版本、OS、功能级别） | `README.md`、`docs/getting-started.md` | 文档审阅 | 用户预期清晰，减少误报 | 回退文档 |
| PKG-001 | 包体优化 | 发布包体最小化（剔除无关资产）并保持可运行 | `package.json(files)` | `npm pack --dry-run` | 包内文件可解释且无泄漏 | 回退 files 配置 |
| SEC-002 | SBOM/供应链 | 生成 SBOM，补充依赖来源与风险记录 | `scripts/quality/*`、`docs/reports/*` | 生成并审阅 SBOM | 可追踪第三方依赖风险 | 回退 SBOM 脚本 |
| DX-001 | 本地开发体验 | 增加 `make`/`npm` 快捷命令文档（dev/test/release） | `README.md`、`CONTRIBUTING.md` | 开发者演练 | 日常开发路径稳定可复制 | 回退命令文档 |

---

## Friday 蓝图闭环专项（必须有收口证据）

| ID | 任务 | 交付物 | 验收标准 |
|---|---|---|---|
| BLUE-001 | 蓝图需求到实现映射（功能→代码→测试→文档） | `docs/BLUEPRINT-CLOSED-LOOP.md` | 每个蓝图目标都有对应实现与测试证据 |
| BLUE-002 | 蓝图关键旅程 E2E 覆盖矩阵 | `docs/reports/release-readiness-*/blueprint-e2e-matrix.*` | 关键旅程全覆盖，失败可定位到模块 |
| BLUE-003 | 未闭环项清零或显式风险接受 | `docs/reports/release-readiness-*/risk-register.*` | 不存在“无 owner、无期限、无策略”的悬空项 |

---

## 最终验收（Go / No-Go）

满足以下全部条件才允许发版：

1. `npm run closeout:final` 退出码为 0。
2. `main` 分支 required checks 全绿。
3. 发布资料齐全：版本号、`CHANGELOG.md`、release notes、`LICENSE`、`SECURITY.md`。
4. 最小 demo 一条命令可复现。
5. 故障自救文档可按步骤复现并恢复。
6. 蓝图闭环文档与证据产物齐全。

## 推荐执行顺序

1. 先做 `P0`，跑通一键收尾。
2. 再做 `P1`，补齐扩展/维护能力。
3. 最后做 `P2`，完善社区与供应链治理。

