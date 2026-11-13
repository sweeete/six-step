# six-step · 六步思考 agent 预设（DSH 插件 / 可安装 bundle）

把「六步思考」做成 **DeepSeek Harness (DSH)** 的一个可安装预设（preset / bundle）。

> 本仓库是分发副本。DSH 打开会话时会把这里的 `cordis.patch.yml`（persona + 团队编排）和 `guard.js`（执行完整性守卫）注入 agent，使其**强制**按六步思考走完每一步、并提交执行凭证。

---

## 六步是什么

每一步的思考结果都必须输出给主人，审计不通过就带结果回第 1 步循环，直到任务圆满完成：

| 步 | 名称 | 必须回答 / 产出 |
|:-:|:--|:--|
| 1 | **是什么** | 把输入逐字拆解（每个词、每句话），字面事实 + 潜台词 |
| 2 | **为什么** | 主人的动机、真实意图、判据 |
| 3 | **怎么做** | 执行方案 + 完成标准 |
| 4 | **任务划分** | 把方案拆成简单子任务（输入 / 输出与验收 / 依赖） |
| 5 | **执行** | 逐子任务动手并给出执行结果 |
| 6 | **审计** | 逐子任务按 8 条清单审计；不达标 → 带结果回第 1 步循环 |

轻量问题（不满足「复杂」判定）单 agent 照走六步（从简）；复杂问题（verdict=复杂）由 **Lead** 领导 6 个具名 teammate（`six-what` / `six-why` / `six-how` / `six-divide` / `six-execute` / `six-audit`）严格串行、压缩接力完成，Lead 只派发、压缩转达、给结果。

## 执行完整性守卫（guard.js）

`guard.js` 注册 `six_step_receipt` 工具 + 两个钩子，保证**形式完整性**（不验证推理真实性）：

- `agent/pre-step`：每真实用户消息重置状态（新一轮重新走六步）。
- `agent/turn-stopping`：最终答复前**必须**提交六步凭证；缺凭证就 `agent.steer()` 拉回重做，**无次数上限**。
- 子 agent（teammate）只做单步、交不出完整凭证，由 `isTeammate()` 豁免放行。

凭证字段：`complexity / path / steps(七项全 done) / subtasks(全 passed=true) / audit(8 条全 true) / concluded=true`。

---

## 安装（两种）

### A. 从本 GitHub 仓库直接装（推荐分发方式）

```bash
# 在 DSH 里执行（或对应 CLI）：
install_bundle git+https://github.com/sweeete/six-step.git
```

装好后进入 DSH 设置，把 **preset** 选为 `six-step`（本预设 id）；之后新会话即走六步思考。

### B. 本地路径

```bash
install_bundle /absolute/path/to/six-step
```

> 安装硬门槛：`guard.js` + `cordis.patch.yml` 随包、且 `package.json` 的 `name` 必须与 `cordis.patch.yml` 里 `six-step-guard` 那一行的 `name` **逐字一致**（否则 guard 不加载）。本仓库两者均为 `@local/dsh-six-step-preset`，已对齐。
>
> 注意：本仓库 `version` 为 `1.0.0`，与 DSH 运行时（`@deepseek-ai/dsh-app-boot` `0.2.2-rc.1`）不要求强制对齐即可普通安装；若要进官方 catalog 则需对齐并改用 `@deepseek-ai/dsh-*` 命名空间（需上游 PR）。

---

## 文件清单

| 文件 | 作用 |
|:--|:--|
| `cordis.patch.yml` | persona（六步铁律 + 团队编排）+ preset 定义 |
| `guard.js` | 执行完整性守卫（零外部依赖，仅 `node:crypto`） |
| `package.json` | bundle 元数据（`dsh.bundle.patch` → cordis.patch.yml） |
| `README.md` | 本说明 |
| `LICENSE` | MIT |

---

## License

MIT © sweeete
