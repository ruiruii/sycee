# SYCEE 发布清单（第三步）

状态：**阶段一已落地、待发布**。文件名与版本已定：包名 `sycee-verify`（npm 不接受大写，`SciVerify` 会被拒绝），版本统一 `0.2.0`。阶段一的 12 个文件改动均已完成并验证；只差维护者提供 npm token 执行实际 `publish`。发布动作需要 token，须由维护者提供并在用后撤销。

发布前验证已完成（2026-11-23）：两个包 `npm pack --dry-run` 内容正确；全新临时目录安装两个 tarball 后，从 `node_modules/.bin/sycee-verify` 跑单文件 1/1、全量目录 76/76——即商家 `npx` 路径已演练通过。

## 一、三个先要拍板的决策

### 1. monorepo 根 `private: true` —— 不拆

根 `package.json` 同时是 workspace 根（`packages/*` + `examples/demo-merchant`），带全部 dev scripts 和 `bin` 字段，且**没有 `files` 白名单**。去掉 private 去发布它，会把 examples、docs、测试一起打进 tarball。

**结论：保留 private。** 发布单元下沉到 `packages/*` 里的具体包。根 `bin` 字段留给本地开发用，不参与发布。

### 2. 让 verify 可 npx 的载体 —— 新建一个包，不动根

`npx sycee-verify` 要求：存在某个包、且其 `bin` 声明了 `sycee-verify`。根包是 private，发布不了，所以必须有一个可发布包来承载它。最小干净做法：

- 新建 `packages/cli/`，包名 **`sycee-verify`**（unscoped，命令名 = 包名，`npx sycee-verify receipt.json` 最短；已确认该名在 npm 上是 404、可用）。
  - `version: 0.2.0`
  - `bin: { "sycee-verify": "./bin/sycee-verify.mjs" }`
  - `dependencies: { "@sycee/core": "^0.2.0" }`
  - `files: ["bin"]`
- 脚本真实现迁到 `packages/cli/bin/sycee-verify.mjs`。它**只** import `@sycee/core`，且已确认 core 导出了它要用的 `refusalRow` / `verifyClaim` / `REFUSAL_SCHEMA_VERSION`——所以 core 一发布，verify 即可独立运行。
- 根 `bin/sycee-verify.mjs` 改成两行转发，保持本地已有路径（`npm run try`、`verify:receipt`、README 示例）不变。
- 备选：若坚持全 scoped 命名，用 `@sycee/verify`，则商家 note 的命令须改成 `npx @sycee/verify`。不影响技术，只影响命令长度。
- **doctor 不进第一版**：它用相对路径 import `../packages/middleware/src/index.mjs` 与 `../packages/agent-sdk/src/index.mjs`，发布后必然断裂；要进包必须先改成包名 import。两周验收只要求 verify，doctor 列为第二阶段。

### 3. 版本 —— 首次发布统一 0.2.0

SPEC 已是 v0.2、refusal row 是 `sycee/refusal/v0.2`，但 npm 包还停在 0.1.0、内部依赖写 `*`。

- 6 个 `packages/*/package.json`：`version 0.1.0 → 0.2.0`；内部依赖 `"*" → "^0.2.0"`（`*` 会原样发布、装到任意版本，首次发布就锁到 `^0.2.0` 更可控）。
- VSR envelope 保持 `sycee/v0.1`，因为 wire 字段集合没变——这是格式版本，不与包版本联动。
- 对外叙事对齐：文档 v0.2 ↔ npm 0.2.0。

## 二、文件改动清单

### 阶段一：达成"可安装 verify"验收

| 文件 | 动作 | 要点 |
|---|---|---|
| `packages/cli/package.json` | 新建 | name `sycee-verify`、`0.2.0`、bin、deps `@sycee/core ^0.2.0`、`files ["bin"]` |
| `packages/cli/bin/sycee-verify.mjs` | 新建 | 迁入真实现；唯一外部 import 是 `@sycee/core` |
| `bin/sycee-verify.mjs` | 改为转发 | 两行 `import '../packages/cli/bin/sycee-verify.mjs'`，本地路径不变 |
| `packages/core/package.json` | 改 | `version → 0.2.0`（无内部依赖） |
| `packages/conformance/package.json` | 改 | `version → 0.2.0`；`@sycee/core * → ^0.2.0` |
| `packages/middleware/package.json` | 改 | 同上 |
| `packages/agent-sdk/package.json` | 改 | 同上 |
| `packages/adapter-automaton/package.json` | 改 | 同上 |
| `packages/probe/package.json` | 改 | `version → 0.2.0`；`core` 与 `adapter-automaton` 两个依赖都改 `^0.2.0` |
| `upstream/merchant-staging-note.md` | 改 | 删掉 "not yet shipped" install note；命令改 `npx sycee-verify` |
| `README.md` / `README.zh.md` | 改 | Quick start 增加 `npx sycee-verify` 外部入口；保留 clone 路径给贡献者 |
| `CHANGELOG.md` | 改 | 增加 `0.2.0` 首次发布条目 |

### 阶段二：doctor 也可 npx（不计入两周验收）

| 文件 | 动作 | 要点 |
|---|---|---|
| `bin/sycee-doctor.mjs` | 改 | 相对 import → 包名 import `@sycee/middleware` / `@sycee/agent-sdk`（两者都已导出 `createGates` / `createSpend` / `reconcile`） |
| `packages/cli/package.json` | 改 | 加 bin `sycee-doctor`；deps 加 `@sycee/middleware`、`@sycee/agent-sdk` `^0.2.0` |

## 三、发布执行顺序（需 npm token）

1. `npm login`（或注入 `NODE_AUTH_TOKEN`）。token 由维护者提供，**发布后撤销**。
2. 先发被依赖者：`npm publish --workspace @sycee/core`
3. 再发依赖者：`npm publish --workspace sycee-verify`
4. 干净环境验证（**无 git clone**、普通目录）：`npx sycee-verify --example` → 应输出 3 条内置 receipt 的 PASS/FAIL，与本地一致。
5. 同环境验证商家 note 那句 `npx sycee-verify receipt.json` 成立。
6. 记录实际发布的版本号与 tarball 校验值，回填 CHANGELOG。

> 顺序不能反：`sycee-verify` 的 tarball 声明依赖 `@sycee/core@^0.2.0`，core 必须先可下载，`npx` 的首次安装才会成功。

## 四、验收口径

外部商家**不 clone 仓库**、仅凭 `npx sycee-verify receipt.json` 就得到与本地一致的代码化判定（哪个规则、为什么失败）→ "可安装的 verify"达成，半页 note 里的命令不再是空话。

## 五、仍不在本清单范围内

- 拒绝行不记录 settlement transaction hash（已知缺口，未排期）。
- 实际 `npm publish` 未执行（无 token）；本清单只做改动规划。
- doctor 的 `npx` 发布（阶段二）。
