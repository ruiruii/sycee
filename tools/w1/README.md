# tools/w1 — x402 证据层现状普查（W1）

`gates-probe` 驱动的自动化证据层普查管线。每周一由 GitHub Actions 官方
runner 真实跑出数据并回写 `reports/w1.md` 与 `reports/w1.json`（`report.mjs`
同时写出这两份）。`reports/w1-en.md` 是 2026-10-10 扫描的手写英文页，仓库里
没有英文渲染器，周任务不覆盖它。

## 它在测什么

SYCEE 站在**裁判位**：持续判定"谁做了持久可验证存证、谁只结算不
存证"。本管线做**双层普查**：

- **权威层（authority）**：公开结算权威（facilitator / ledger / receipt
  服务）。对每种做形态分类，仅对哈希链账本形态跑完整 gates 谓词深度。
- **卖家层（seller）**：公开 discovery 目录所列的**资源服务器（卖家）**。
  只问一个证据问题——"你是否自建持久存证面（账本 / 回执）"——验证
  "存证责任是否完全落在 facilitator 一侧"这一结构性假设。

报告的核心数字是**生态规模 vs 存证覆盖**的落差：公开 x402 资源有多少在
卖，而其中只有几个端点暴露持久可验证的证据面。

## 三件套 + 分类器

| 文件 | 作用 |
|---|---|
| `discover.mjs` | 拉 Circle / CDP 公开 discovery 拿生态规模，并解析出**卖家 origin 清单**（`sellers.txt`）；同时输出证据权威端点种子（`endpoints.txt`）与 `discovery.json` |
| `scan.mjs` | 双层扫描：权威层做形态分类 + 账本深度；卖家层用并发池只探证据面 |
| `report.mjs` | 渲染 `reports/w1.md`（生态规模 vs 存证覆盖 + 双层形态分布 + 逐端点明细 + 账本深度表） |
| `surface.mjs` | 形态分类器（探测 `/v2/ledger`、`/v2/pubkey`、`/v1/receipt-key`；权威层另加 `/supported`、`/health`） |

## 形态定义

| 形态 | 含义 |
|---|---|
| `attestation-ledger` | 可读的哈希链账本（automaton 式）——持久、可独立验证的存证 |
| `signed-receipt` | 公布签名回执 + 密钥文档（bsvkey 式） |
| `settlement-only` | 可达的 x402 facilitator，但无持久存证面（只结算、不存证） |
| `no-evidence` | 可达但未暴露上述任何证据面（卖家层常态） |
| `unreachable` | 无法连接 |

**可达性语义**：只要任一被探路径返回了 HTTP 响应（含 404）即视为可达；
全部无响应才算不可达——避免把"活但不存证"的卖家误判为宕机。证据面则
要求返回 **2xx 且为 JSON**，HTML 落地页不计，避免误报。

## 本地复现（需正常出网）

```bash
node tools/w1/discover.mjs --out tools/w1/endpoints.txt --sellers-out tools/w1/sellers.txt --discovery-out tools/w1/discovery.json
node tools/w1/scan.mjs --list tools/w1/endpoints.txt --sellers tools/w1/sellers.txt --out tools/w1/w1-raw.json
node tools/w1/report.mjs
```

沙箱无法直连大多数端点（DNS 被占位），真实数据由 CI 产出。
