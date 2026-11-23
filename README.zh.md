# SYCEE

[![CI](https://github.com/ruiruii/sycee/actions/workflows/ci.yml/badge.svg)](https://github.com/ruiruii/sycee/actions/workflows/ci.yml)

**别人证明“送到了”，SYCEE 证明“被用了”。**

HTTP `200` 只说明字节到达了，不说明 agent 把它们放进了 prompt、传给了工具，还是压根没留。
SYCEE 记录这个差别，并统计同一份付款凭证被兑现了几次。

`SYCEE` 是机器支付上的语义层，不绑定具体协议。它回答两个上游协议至今没有定义的问题：

1. **付过钱的那份结果，真的被下游用了吗？**
2. **同一份付款凭证，被兑现了几次？**

> 我们只记录，不打分。不托管，不碰钱，不做信誉分。

英文版：[README.md](./README.md)

---

## 三步跑通

Node 20 以上。不需要钱包、不需要联网、不需要账号——演示里的付款凭证只是一个字符串，
SYCEE 全程只处理它的哈希。

只想验一张收据，不用 clone 仓库：

```bash
npx sycee-verify receipt.json          # 或：npx sycee-verify --example
```

要在仓库里开发：

```bash
git clone https://github.com/ruiruii/sycee.git
cd sycee
npm install
npm run try                           # 三十秒：三张收据，各查一条规则
npm test                              # 248 个测试
npm run verify:py                     # 同一批 12 个向量，用 Python 再验一遍
node examples/bilateral-consumption.mjs
```

`npm run try` 不用给任何输入。它把三张收据交给检查器，打印每一张错在哪里：

```text
PASS  a repeat presentation that names the settlement it saw
      refused · duplicate_payment · settled · final · chain_verifiable

FAIL  a failed transfer whose transfer leg was never read
      leg_contradicts_reason
      transfer_leg_failed needs transfer = failed, the row records unknown
      refused · transfer_leg_failed · unknown · not final

FAIL  a pending settlement presented as final
      finality_pending_is_not_final
      settlement is pending, so the row cannot be final — the payment may
      still land
      refused · internal_error · pending · final

1/3 passed, 2 failed
```

没联网、没读密钥、没碰任何服务。那两条失败正是这个格式存在的理由：一张收据如果理由
和它自己的字段互相矛盾，它就说了不真的话；检查器给出它破了哪条规则，而不是给它打分。

检查自己的收据——作为使用者（`npx`，不用 clone）或在仓库内：

```bash
npx sycee-verify receipt.json                                 # 不用 clone
node bin/sycee-verify.mjs receipt.json                         # 在仓库内
node bin/sycee-verify.mjs --dir conformance/refusal/vectors    # 76/76
```

它吃三种输入：已经构造好的行、构造器的输入、一致性向量文件；输出的错误码和向量集用的
是同一套。`--json` 给流水线用。

那条走查命令把同一个搜索接口买了两次。一次结果被用了，一次被扔了：

```text
WHAT THE SELLER RECORDED
  call 1  status=delivered  consumed=unknown  redeem_count=1
  call 2  status=delivered  consumed=unknown  redeem_count=1

WHAT THE BUYER RECORDED
  call 1  consumed=yes  consumed_by=["msg_4829"]
  call 2  consumed=no   consumed_by=[]
```

两笔付款、两次交付、两张签名收据——**而商家分不出这两笔的区别**。只有买方的运行时知道
哪份结果进了 prompt，也只有买方能签这个字。这个签名就是产品本身。

产品的另一半，是两本账能摆在一起对。买方的条目和卖方的拒绝行共享同一个 identity（§3.1），
所以一次纠纷只会得到 `match` / `status_disagrees` / `only_buyer` / `only_seller`——永远不是
一个裁决。见 [`examples/buyer-reconcile.mjs`](./examples/buyer-reconcile.mjs)。

其他入口：`npm run demo`（一个收款服务端 + 一个买家，同一进程）、
`npm run demo:bilateral`（买方和卖方账本按 identity 对账）、
`npm run demo:refusal`（四次被拒，每张拒付声明离线核验）、
`node bin/sycee-doctor.mjs`（指出是哪一段被配错的反向代理改了）、
`npm run verify`（12 个签名向量）。

## 问题在哪

| 层 | 回答什么 | 现状 | 缺什么 |
|---|---|---|---|
| x402、MPP、AP2 | agent 怎么付钱 | 标准和 SDK 已有 | — |
| x402-receipts、Vauban | 付款发生了吗、商家交付了吗 | 生产代码、IETF 草案 | 消费证据 |
| ERC-8183、VCAP | 评估者判定完成了吗 | 托管 / 裁定层 | 非托管、非评分的证据 |
| **SYCEE** | **结果被用了吗？兑现了几次？** | **本仓库** | — |

HTTP `200` 不会告诉你 agent 有没有把结果：

- 放进 prompt
- 传给另一个工具
- 存进工作记忆
- 给用户看

这个缺口叫**空转消费**（idle spend）：钱花了、字节到了、价值没用上。也是同一份
`payment_proof` 被拿去兑现多个资源而没人发现的缺口。SYCEE 让这两件事都能被看见。

## SYCEE 不是什么

- **不是支付协议**。它站在 x402（或任何支付通道）旁边，记录通道记不了的东西。
- **不是收据格式的竞争者**。它只给已有格式加两个字段。
- **不是评分系统**。没有信任分、没有信用分、没有黑名单。
- **不是托管方**。不托管、不转账、不记余额。
- **不是锚定产品**。NEAR 只是可选时间戳层的一种实现。

## 合规等级

| 等级 | 要求 | 含义 |
|---|---|---|
| **L0** | 输出 `payment.proof_hash`、`delivery.status`、`result.consumed`、`payment.redeem_count` | 只有遥测 |
| **L1** | L0 + 单边签名收据 | 声明，不是证明 |
| **L2** | 两张已签名收据（一张商家、一张 agent），`proof_hash` 与 `resource_id` 配对成功 | `consumed` 被证实；等级是这一对的判定结果 |

两个区别。第一，商家可以说 `delivered`，但**必须**说 `consumed: unknown`（除非结果块已联签）；
商家单独签 `consumed: yes` 是在声明它观测不到的事。第二，**L2 是对一对收据的判定，不是一个字段**：
单张信封写 `completeness: bilateral` 仍然只到 L1——因为对方那张可能不存在、可能没签名、也可能
描述的是另一次尝试。`linkReceipts()` 只有在两边都验过、且角色不同时才返回 `level: 'L2'`。

```bash
npm run verify       # 12 个签名向量，期望值强制校验
npm run verify:l0    # 按等级跑
npm run matrix       # 12 个判定打成一页
```

[`conformance/vectors/matrix.svg`](./conformance/vectors/matrix.svg) 把每个向量要证明什么、
校验器给出什么判定、文件 SHA-256 打在一页上，由 `manifest.json` 生成，不手工维护。

### 第三方读者

§15 那些拒绝行向量，由一份不是我们写的实现读过一遍——只读文字，所有猜测在运行前就写下来：

> [holistis/agent-receipt-verify](https://github.com/holistis/agent-receipt-verify)，
> [`research/sycee-section-15-third-reader`](https://github.com/holistis/agent-receipt-verify/tree/main/research/sycee-section-15-third-reader)，
> 2026-11-20，针对 `sycee@632c2f56`。

第一次跑（当时是 25 个文件，现在是 40 个）：21 个一致，8 个错误孪生全部与其正确孪生不同。4 个不一致的地方，
是文字和向量互相矛盾的地方——记录下来，不裁定谁对，见
[`conformance/refusal/README.md`](./conformance/refusal/README.md)。

值得读两遍的是另一组数：同一份报告在（当时那）25 个文件里植入了 21 个看似合理的错误，
**15 个照样全过**。一套抓不住错误实现的向量集，等于没被测过——而这是我们目前
唯一一次来自外部的这种测量。

## 仓库里有什么

```
SPEC.md                       规范 v0.1
schema/vsr-v0.1.schema.json   可验证消费收据的 JSON Schema
conformance/vectors/          签名合规向量 + 矩阵
packages/
  core/                       规范化 JSON、Ed25519、收据构造、离线校验
  middleware/                 商家侧 HTTP 守卫（challenge、重复兑现、拒绝行）
  agent-sdk/                  agent 运行时 SDK（算 identity、留拒绝凭证、联签）
  conformance/                校验器与 CLI
  adapter-automaton/          绑定哈希链存证账本（RW-001）
  probe/                      证据层 CLI（probe / verify / batch）
python/                       第二套校验器（Ed25519 + 规范化 JSON），不 import 任何 JS，同一作者
examples/                     走查、双边演示、五分钟接入、演示商家、NEAR 锚定
upstream/                     给 x402-receipts、Vauban、ERC-8004 的现成提案稿
docs/observations.md          别的实现的实际情况，按日期+行号记录
```

所有包零依赖，用 Node 原生 Ed25519。

## 接入方式

**商家侧。** `createGates` 包住一个 handler：发 402 挑战、按 `proof_hash` 统计兑现次数、
附上签名收据。

```js
import { createGates, memoryStore } from '@sycee/middleware';
const gates = createGates({
  resourceId: 'search.v1', protocol: 'x402',
  price: { value: '0.010000', currency: 'USDC' },
  payTo: '0x00000000000000000000000000000000000000bb',  // 必填：identity 由它参与组成
  network: 'eip155:8453',
  scheme: 'exact',
  publicKey, privateKey,
  store: memoryStore(),        // 生产环境用 redisStore(client)
});
app.get('/search', gates.guard(async () => ({ status: 200, body: { ok: true } })));
```

**Agent 侧。** `createSpend` 包住 `fetch`，拿到商家收据，并让运行时声明结果被怎么处理了。

```js
const res = await spend.fetch('https://api.example/search?q=ai');
const receipt = res.gates.consumedBy('task_4829');   // 或 .notConsumed()
```

**校验。** 两边都不需要对方，也不需要联网：

```js
import { verifyVSR } from '@sycee/core';
verifyVSR(envelope);                            // { valid, level, errors, warnings }
import { linkReceipts } from '@sycee/agent-sdk';
linkReceipts(merchantEnvelope, agentEnvelope);  // { level: 'L2', completeness: 'bilateral', ... }
```

线格式里的 `x-gates-*` 头和收据里的 `gates_spec` 字段是给已接入的传输层留的兼容名，
不是包名。

---

## 红线

合规实现**不得**：

1. 存储或传输原始付款凭证正文。
2. 产出信任、信用或信誉评分。
3. 转移资金或充当托管。

这些是结构约束，不是政策承诺。见 [SPEC.md](./SPEC.md)。

## 与相邻项目的关系

SYCEE 是叠加，不是竞争。

| 项目 | 定义什么 | SYCEE 补什么 |
|---|---|---|
| **x402-receipts** | 收据格式、请求哈希、交付状态、双签 | `consumed` / `redeem_count`；多通道 |
| **IETF draft-vauban-x402-*** | 收据格式、后量子签名、Starknet 锚定 | `consumed` / `redeem_count`；与协议无关 |
| **ERC-8183** | 链上托管、评估裁定 | 链下、非托管的消费证据 |
| **VCAP / SwarmSync** | 托管结算、交付证明、信誉 | 不托管、不评分 |
| **ERC-8004** | agent 身份与付款凭证 schema | 为 `consumed` / `redeem_count` 预留字段 |

## 上游推进

目标是**一套词汇，而不是一个新项目**。如果别的标准采纳了这两个字段名，SYCEE 就采纳他们的。

| 对象 | 渠道 | 状态 |
|---|---|---|
| x402-receipts (StelarDigital) | GitHub issue | [#6](https://github.com/StelarDigital/x402-receipts/issues/6) — 已收敛 |
| ERC-8004 v2 | GitHub issue | [erc-8004-contracts#102](https://github.com/erc-8004/erc-8004-contracts/issues/102) — open |
| Vauban Research (IETF) | GitHub issue | [x402-stark-receipts-conformance#3](https://github.com/vauban-org/x402-stark-receipts-conformance/issues/3) — open |
| Predge | GitHub issue | [erc8004-outcome-validator#13](https://github.com/predgeAI/erc8004-outcome-validator/issues/13) — open |
| Brave `bx402` | GitHub issue | [bx402#141](https://github.com/brave/bx402/issues/141) — open |

一个值得点明的期限：Vauban 的 `draft-vauban-x402-stark-receipts` 在 **2026-11-26** 到期，
`consumed` 语义需要在那之前有至少一个采纳方，否则相邻字段会被别人先定义。

别的实现究竟怎么做的——按日期读的快照、带行号的引用，包括对我们不利的那一条——记在
[docs/observations.md](./docs/observations.md)。

## 托管证据服务

本仓库的包永久免费、Apache-2.0。另有一个托管服务，替客户保存已签名收据的第三方副本、
按需锚定。它在试点中，**不在本仓库实现**，不托管资金。哪些是开源的、哪些是商业层、
试点覆盖什么：[docs/hosted-service.md](./docs/hosted-service.md)。

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| 1 | 发布仓库 + SPEC v0.1 | 完成 |
| 2 | 向 x402-receipts、Vauban、ERC-8004 做字段对齐 | 完成，线仍开着 |
| 3 | 第一个独立实现采用 `consumed` / `redeem_count` | 待定 |
| 4 | 商家 + agent SDK 跑通真实卖家（Brave / bx402） | 待定 |
| 5 | 跨通道支持（APOP、alipay-a2m、a2p2） | 待定 |

## 命名

v0.1 之前叫 `gates-spec`，现名 `SYCEE`。旧 `gates-spec/v0.1` 收据签名仍有效；12 个向量
因版本串参与指纹而重新生成。包名从 `@gates-spec/*` 迁到 `@sycee/*`。

## 参与

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。最需要两件事：其他语言的独立实现、上游对齐。

## 许可证

Apache-2.0，见 [LICENSE](./LICENSE)。

---

<sub>黑客松提交材料（NEAR，2026 年 10 月）原样保存在
[docs/hackathon.md](./docs/hackathon.md)。组件设计见
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。</sub>
