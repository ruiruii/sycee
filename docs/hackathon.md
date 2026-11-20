# Hackathon submission record (NEAR, October 2026)

This file is the submission material as it was written, kept verbatim so the record stays
checkable. It is **not** the project entry point: the protocol, the packages and the
conformance suite are described in the [main README](../README.md).

The NEAR anchor it describes is an optional public timestamp layer. Nothing in the core
packages requires it. See [`examples/near-anchor/README.md`](../examples/near-anchor/README.md)
for that component on its own.

---

# SYCEE

[![CI](https://github.com/ruiruii/sycee/actions/workflows/ci.yml/badge.svg)](https://github.com/ruiruii/sycee/actions/workflows/ci.yml)

SYCEE is the evidence layer for AI agent payments: every payment gets a signed receipt, fingerprinted on NEAR, that anyone can verify, and SYCEE never touches the funds.

Node.js 20 or newer, and [rustup](https://rustup.rs). The build installs Rust 1.86.0. No NEAR account and no secret.

```bash
git clone https://github.com/ruiruii/sycee.git
cd sycee
npm install
cd examples/near-anchor
npm install
bash scripts/build.sh
npm run demo:e2e
NEAR_CONTRACT_ID=sycee-anchor.testnet node scripts/verify.mjs --receipt fixtures/sample-receipt.json
```

What you will see:

```text
159146
payment: SIMULATED
receipt_hash: sha256:<64 hex>
verify: ok true
"ok": true,
"hash": "sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03",
```

`159146` is the wasm size from `bash scripts/build.sh`. `payment: SIMULATED`, `receipt_hash:`, and `verify: ok true` are from `npm run demo:e2e` (that hash is new each run). `"ok": true` and the `sha256:f296fd15…` fingerprint are the verify command.

- Live demo: [https://ruiruii.github.io/sycee/](https://ruiruii.github.io/sycee/)
- Demo post: [https://x.com/aking_z/status/2121175201778143394](https://x.com/aking_z/status/2121175201778143394)
- Video: [https://x.com/aking_z/status/2121175474265313681](https://x.com/aking_z/status/2121175474265313681)

## Architecture

An agent pays a merchant over x402. The merchant middleware and the agent SDK each sign a receipt. SYCEE fingerprints that signed receipt, and a restricted key anchors the fingerprint on NEAR. Anyone can check it. Dashed boxes are the hosted evidence service. That service is proposed and is not built in this repository.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": true, "background": "#0c0b09", "primaryColor": "#16130e", "primaryTextColor": "#f6f0e4", "primaryBorderColor": "#e2be62", "secondaryColor": "#16130e", "tertiaryColor": "#100e0b", "lineColor": "#e2be62", "textColor": "#f6f0e4", "clusterBkg": "#100e0b", "clusterBorder": "#c6a15b", "titleColor": "#f3d48a", "edgeLabelBackground": "#16130e", "fontFamily": "arial, sans-serif"}}}%%
flowchart TB
  agent["AI agent<br/>@sycee/agent-sdk"]
  rail["x402 facilitator<br/>payment rail, not SYCEE"]
  merchant["Merchant API<br/>demo merchant"]
  agent -->|x402 payment| merchant
  rail -->|verifies and settles| merchant

  msign["Merchant signature, built<br/>consumed stays unknown<br/>counts redeem_count<br/>header x-gates-receipt"]
  asign["Agent signature, built<br/>consumed yes or no<br/>linkReceipts"]
  merchant --> msign
  agent --> asign

  hash["Receipt fingerprint, built<br/>sha256 of the canonical JSON<br/>of the signed envelope"]
  msign --> hash
  asign --> hash

  fkey["Restricted function-call key, built<br/>anchor and anchor_batch only<br/>cannot move funds"]
  near["NEAR anchor, built<br/>sycee-anchor.testnet<br/>hash, chain, merchant id<br/>block height and time"]
  hash --> fkey --> near

  script["verify.mjs, built<br/>Ed25519, then get_anchor"]
  page["Demo page, built<br/>recomputes sha256<br/>NEAR RPC when live"]
  pages["GitHub Pages, built<br/>ruiruii.github.io/sycee"]
  near --> script
  near --> page
  page --> pages

  subgraph hosted ["Hosted evidence service, planned"]
    direction LR
    store["Receipt storage"]
    dash["Verification dashboard"]
    asvc["Anchoring service"]
    track["redeem_count, then consumed"]
  end
  hash -.->|planned copy| store
  store --- dash
  store --- asvc
  store --- track

  bounds["No custody<br/>No fund movement<br/>No scoring"]
  pages --> bounds

  classDef built fill:#16130e,stroke:#e2be62,color:#f6f0e4,stroke-width:1.5px
  classDef railnode fill:#16130e,stroke:#c4b08a,color:#f6f0e4,stroke-width:1.5px
  classDef planned fill:#100e0b,stroke:#e2be62,color:#f3d48a,stroke-width:1.5px,stroke-dasharray:6 4
  classDef quiet fill:#100e0b,stroke:#e2be62,color:#f3d48a,stroke-width:1px
  class agent,merchant,msign,asign,hash,fkey,near,script,page,pages built
  class rail railnode
  class store,dash,asvc,track planned
  class hosted planned
  class bounds quiet
```

[High-res diagram for slides](docs/architecture.svg) · [PNG](docs/architecture.png) · [Component notes](docs/ARCHITECTURE.md)

Solid outlines are in this repository today. The x402 facilitator is the payment rail: the demo calls it, and SYCEE does not take custody or move funds. Dashed outlines are planned.

## Why this fits the tracks

**AI Security & Defense.** The agent holds a restricted NEAR function-call key that can call only `anchor` and `anchor_batch`. A leaked agent key cannot move funds, add keys, or transfer. After the block above, from `examples/near-anchor`:

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
npm run demo:security
```

You see `key: function-call`, `methods: anchor,anchor_batch`, `deposit: not allowed`, `anchor_with_limited_key: ok`, `transfer NEAR: rejected`, `add key: rejected`, `call add_anchorer: rejected`, `attached deposit: rejected`, and `duplicate anchor: rejected`. A `Failure` line in the sandbox log is a rejected call. The summary still says `rejected`, and the command exits 0. This run stays on the local sandbox and needs no key.

**Agent Economy.** Agents pay for APIs and data over x402. The merchant signs a receipt for what was bought. The NEAR anchor is the public fingerprint of that receipt, so anyone can check it later without holding the payment.

**Real-World Money.** A merchant paid by an agent gets a verifiable receipt and a public fingerprint to keep as evidence of that payment. The receipt holds hashes and a signature. SYCEE does not invoice, hold, or move the merchant's funds.

## Sustainability

The open-source core in this repository stays free under Apache-2.0. The paid layer is a hosted evidence service: receipt storage, a verification dashboard, and anchoring. It keeps copies of receipts that are already signed. It does not take custody and it does not move funds. The service is in pilot with partners. See [Hosted evidence service](#hosted-evidence-service-proposed-in-pilot).

---

演示页面（打开就能看，不需要钱包）：[https://ruiruii.github.io/sycee/](https://ruiruii.github.io/sycee/)（也有本地文件 [examples/near-anchor/demo/index.html](examples/near-anchor/demo/index.html)）。

直接核对测试网上那笔模拟付款（`tx` 必须是完整的 nearblocks 网址，页面不认单独的交易号）：[https://ruiruii.github.io/sycee/?hash=sha256:618a391577ebd1e6a94430f05947e74c84a7d59523034ed28851b712a40ead81&offline=0&tx=https%3A%2F%2Ftestnet.nearblocks.io%2Ftxns%2F6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo](https://ruiruii.github.io/sycee/?hash=sha256:618a391577ebd1e6a94430f05947e74c84a7d59523034ed28851b712a40ead81&offline=0&tx=https%3A%2F%2Ftestnet.nearblocks.io%2Ftxns%2F6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo)。线上页面已经从 main 部署，并且会读取 `hash`、`offline` 和完整的 nearblocks `tx`。

## 我们解决什么

机器帮人付钱（agent payment）之后，旁人怎么确认那张收据没被改过。我们要的是一张能核对的收据（verifiable receipt）。演示商家在 Base Sepolia 上卖一个 0.001 美元的测试接口并签名收据。我们不给人打分，不保管钱，也不转账。

## 用了什么技术

收据仍在 Base Sepolia 产生。我们只把收据的指纹记到 NEAR 测试网，这就是跨链留痕（cross-chain anchoring）。指纹算法和 SYCEE 自己的一样。合约里只有指纹、来源链、商家公开地址、区块高度和时间。没有付款原文。测试网合约账号是 `sycee-anchor.testnet`（主人也是这个账号，写入名单是空的）。部署交易：[J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h](https://testnet.nearblocks.io/txns/J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h)。来自提交 `01b4e419`，wasm 159146 字节，sha256 `c027e046864760b51848501cec91c5c0b4e738d6dc94de86ce63d3d0ae98a236`。

## 怎么验证

1. 打开上面的演示页。里面已经放了一张示例收据。勾着「离线示例」，它会算出 `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`，并和页内写死的指纹对照。这一步不连网。
2. 开发者在 `examples/near-anchor/` 跑 `bash scripts/build.sh` 和 `npm test`。合约 wasm 159146 字节。Rust 测试 6 个、Node 单元测试 16 个、本地 NEAR 沙箱测试 3 个，都已通过。沙箱覆盖写入、重复拒绝、外人拒绝、查询、核对脚本、端到端演示和受限钥匙演示。
3. 示例收据 `examples/near-anchor/fixtures/sample-receipt.json` 已经写在 `sycee-anchor.testnet`。指纹 `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`，来源链 `eip155:84532`，商家 `sycee:demo-merchant`，区块 277456711。锚定交易：[9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ](https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ)。`verify.mjs` 返回成功。这是核对过的结果，不是计划。

## 这次黑客松做了什么

SYCEE 的规格和签名代码在 2026-10-19 之前就有了。那天是 NEAR 黑客松公布的日子。那天之前最后一次提交是 [`f1af69d`](https://github.com/ruiruii/sycee/commit/f1af69de1f461d9d656f598473042187e9118db1)（2026-10-12）。

这次新做的是 NEAR 这一段：`examples/near-anchor/` 里的合约、演示页、端到端演示和受限钥匙演示。对照从那次旧提交到 main：

https://github.com/ruiruii/sycee/compare/f1af69de1f461d9d656f598473042187e9118db1...main

这个对照里也有 10 月 19 日之后合进 main 的其他改动，包括 Base Sepolia 演示商家。NEAR 合约本身是后来加的。标签 `pre-hackathon` 和 `hackathon-submission` 由主人自己加，这里不打标签。

## 用了哪些现成的东西，哪些是 AI 写的

- `near-sdk` 5.7.1：写合约
- `near-workspaces` 和里面的 `near-sandbox`（nearcore 2.6.2）：本地沙箱，默认演示和测试用它
- `near-api-js` 5：脚本签名、发交易
- `near-cli-rs`：人自己部署时用，不是 npm 依赖
- binaryen 的 `wasm-opt`：把编译结果收成沙箱能加载的格式
- `@sycee/core` 和演示商家：10 月 19 日之前或之后已经在 main 上的 SYCEE 代码，算原有基线

`examples/near-anchor/` 里的大部分代码是用 Cursor 的 AI 编程助手写的，再由团队看过。

## 三步试一下

在仓库根目录做。每一步做完，你应该看到右边这些字。

1. 安装并编译。需要 Node.js 20 或更新版本，以及 rustup。`scripts/build.sh` 会安装 Rust 1.86.0。下面每一段命令都从仓库根目录算起，新开一个终端也能跑。

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
cd examples/near-anchor
npm install
bash scripts/build.sh
```

你看到：最后一行是 wasm 的字节数，`159146`。

2. 跑默认的端到端演示。这是模拟付款，没有真的转账，也不需要钥匙。

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
npm run demo:e2e
```

你看到这些行：`payment: SIMULATED`，`payment_note: mock facilitator, no Base Sepolia transfer, no funds moved`，`http_status: 200`，`receipt_hash: sha256:` 后面 64 位，`chain: local NEAR sandbox`，`verify: ok true`，`nearblocks: n/a`。

3. 用已经部署的测试网合约核对仓库里的示例收据。这一步只读，不花钱，不需要钥匙。

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
NEAR_CONTRACT_ID=sycee-anchor.testnet node scripts/verify.mjs --receipt fixtures/sample-receipt.json
```

你看到 JSON 里 `"ok": true`，以及 `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`。

演示页可以贴第 2 步打印的整段，或只贴 `receipt_hash` 那一行。地址可以带 `?hash=sha256:...&tx=https://testnet.nearblocks.io/txns/...&offline=0`。取消「离线示例」后，它会去问 `sycee-anchor.testnet`。沙箱里新算出来的指纹不在测试网上，这是正常的。示例收据那条在测试网上，区块 277456711。

可选。下面这一步需要你自己已经有的 NEAR 账号和钥匙。上面的演示不需要。钥匙在 `~/.near-credentials/testnet/sycee-anchor.testnet.json` 或 `NEAR_PRIVATE_KEY`，脚本不打印钥匙：

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
NEAR_ACCOUNT_ID=sycee-anchor.testnet NEAR_CONTRACT_ID=sycee-anchor.testnet npm run demo:e2e -- --testnet
```

你看到：`payment: SIMULATED`，`chain: NEAR testnet`，`verify: ok true`，`nearblocks: https://testnet.nearblocks.io/txns/` 开头的链接。演示页地址会带上 `&tx=`。

已经在测试网跑通一次。交易 [6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo](https://testnet.nearblocks.io/txns/6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo)，收据指纹以 `sha256:618a3915` 开头（完整 64 位在这笔交易里）。付款仍是模拟的，没有在 Base 上转账。

安全演示，默认也在本地沙箱，不需要钥匙：

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
npm run demo:security
```

你看到：`key: function-call`，`methods: anchor,anchor_batch`，`deposit: not allowed`，`anchor_with_limited_key: ok`，`transfer NEAR: rejected`，`add key: rejected`，`call add_anchorer: rejected`，`attached deposit: rejected`，`duplicate anchor: rejected`。

这把钥匙只能调用这个合约的 `anchor` 和 `anchor_batch`，并且只能用额度里的 gas。它不能转 NEAR，不能附带存款，不能再加钥匙，也不能调别的方法。合约自己还拒绝重复指纹、拒绝名单外的账号、拒绝别人转进来的 NEAR。

可选。要在测试网上看同一件事，需要你自己已经有的 NEAR 账号。这一步会给 `sycee-anchor.testnet` 加一把受限钥匙，只花测试网的手续费：

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
NEAR_ACCOUNT_ID=sycee-anchor.testnet NEAR_CONTRACT_ID=sycee-anchor.testnet npm run demo:security -- --testnet
```

已经在测试网跑通。受限公钥 `ed25519:7G1L5eMc5pKCJcVNbHvv68j1THA6bxc9QDFg7sFN4Qjy`，加钥匙的交易是 [HpZaM37gDbngx7skC1vjk81QFkjb7Yv2jLHN7GGWSLnh](https://testnet.nearblocks.io/txns/HpZaM37gDbngx7skC1vjk81QFkjb7Yv2jLHN7GGWSLnh)，用这把钥匙写入的交易是 [9u6vfDWwuMdUcyVb3LXDUuotbdQBF68EmbX7Z6oRM8r6](https://testnet.nearblocks.io/txns/9u6vfDWwuMdUcyVb3LXDUuotbdQBF68EmbX7Z6oRM8r6)，重复写入被合约拒绝的交易是 [234ghPupTc158iY6osT53vBTML823BrGYLgdeNg4dPM6](https://testnet.nearblocks.io/txns/234ghPupTc158iY6osT53vBTML823BrGYLgdeNg4dPM6)。转账、再加一把钥匙、调用 `add_anchorer` 在钥匙校验时就被拒绝，区块浏览器上不一定看得到这三笔失败。

```mermaid
flowchart LR
  agent[代理]
  merchant[演示商家]
  receipt[签过名的收据]
  key[只能写指纹的钥匙]
  near[NEAR 合约]
  page[核对页面]
  agent -->|付款| merchant
  merchant --> receipt
  agent --> key
  key -->|只写指纹| near
  receipt --> page
  near --> page
```

| 评审看什么 | 我们做了什么 | 证据 |
|---|---|---|
| 技术能不能跑 | 合约、本地沙箱、端到端命令 | `npm run demo:e2e`，`.github/workflows/near-anchor.yml` |
| 设计 | 只存指纹，不评分，不碰钱 | `examples/near-anchor/contract/src/lib.rs` |
| 有没有用 | 测试网上能查到示例收据 | [锚定交易](https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ) |
| 是不是自己的东西 | 旧代码在 10 月 19 日前；NEAR 这段是新的 | [对照](https://github.com/ruiruii/sycee/compare/f1af69de1f461d9d656f598473042187e9118db1...main) |
| 能不能接着用 | 不托管资金；代理钥匙权限被收窄 | `npm run demo:security` |

完整中文说明：[examples/near-anchor/SUBMISSION.zh.md](examples/near-anchor/SUBMISSION.zh.md)。主人清单：[examples/near-anchor/提交清单.md](examples/near-anchor/提交清单.md)。

---

A page you can open, with no wallet: [https://ruiruii.github.io/sycee/](https://ruiruii.github.io/sycee/). The same file is [examples/near-anchor/demo/index.html](examples/near-anchor/demo/index.html).

Live check of the recorded testnet receipt. The `tx` parameter must be the full nearblocks URL:

[https://ruiruii.github.io/sycee/?hash=sha256:618a391577ebd1e6a94430f05947e74c84a7d59523034ed28851b712a40ead81&offline=0&tx=https%3A%2F%2Ftestnet.nearblocks.io%2Ftxns%2F6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo](https://ruiruii.github.io/sycee/?hash=sha256:618a391577ebd1e6a94430f05947e74c84a7d59523034ed28851b712a40ead81&offline=0&tx=https%3A%2F%2Ftestnet.nearblocks.io%2Ftxns%2F6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo)

The site that is live now was deployed from main. It reads `hash`, `offline`, and a full nearblocks `tx` URL.

This is the English text of [examples/near-anchor/SUBMISSION.zh.md](examples/near-anchor/SUBMISSION.zh.md). The same file is [examples/near-anchor/SUBMISSION.en.md](examples/near-anchor/SUBMISSION.en.md).

## Problem

An agent pays for a call on a person's behalf (agent payment). After the payment, how can someone else tell that the receipt was not edited?

SYCEE already issues a verifiable receipt. The demo merchant, on Base Sepolia, sells one test call, `GET /v1/base/tip`, for 0.001 test USDC. When the payment is accepted, the merchant signs a receipt. The receipt holds hashes and a signature. It does not hold the payment itself.

What was missing is a public time record: this receipt's fingerprint was written down at a known moment. This project does not score anyone, does not hold funds, and does not move funds.

## Solution

The receipt is still produced by the demo merchant on Base Sepolia. This project copies the receipt's fingerprint onto NEAR. That copy is the cross-chain anchoring step: one chain produces the receipt, the other stamps the fingerprint with a block time.

The fingerprint uses the same algorithm SYCEE already uses. The receipt is turned into one canonical JSON text, then SHA-256. For the sample receipt in this repo, that value is `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`.

That sample is not a payment that happened. The demo page recomputes it with the same algorithm and can match this string with no network.

The contract stores the fingerprint, the source chain (for example `eip155:84532`), the merchant's public payTo address, the block height, the time, and which account wrote it. It does not store the receipt body, the payment proof, or personal data.

Who may write is fixed at deploy. Everyone else can only read. The same fingerprint cannot be written twice.

## What we built on NEAR

The contract is in `examples/near-anchor/contract/`. It does not accept NEAR and it does not send NEAR. In plain language the methods are:

- `new`: at deploy, sets the owner and any other accounts allowed to write. Called once.
- `anchor`: writes one receipt fingerprint. A repeat is rejected. An account that is not on the list is rejected.
- `anchor_batch`: writes up to 32 fingerprints and computes one combined fingerprint (a Merkle root). The contract computes that root. The caller does not get to invent it.
- `get_anchor`: looks up one fingerprint. Returns empty when it was never written.
- `is_anchored`: whether that fingerprint is stored.
- `get_batch`: looks up one combined fingerprint.
- `verify_inclusion`: given one fingerprint and a short proof, checks that it belongs to that combined fingerprint and that this contract stored the batch.
- `add_anchorer` / `remove_anchorer`: the owner adds or removes a writer. The owner cannot be removed.
- `get_owner` / `is_anchorer`: read the owner and the writer list. Anyone can read.

Each write emits a public log in the NEP-297 shape. The log is fingerprints and labels only.

Checking happens in two places. The browser page only recomputes the fingerprint. The Node script `examples/near-anchor/scripts/verify.mjs` also checks the SYCEE signature, then compares the fingerprint on chain. The chain does not check the signature, does not decide whether the payment succeeded, and does not decide whether the buyer used the result.

## Results

These ran on this machine. They are not a plan.

- The contract builds. `bash examples/near-anchor/scripts/build.sh` writes a wasm of 159146 bytes (`examples/near-anchor/out/sycee_anchor.wasm`).
- 6 Rust unit tests passed (`cargo +1.100.0 test`): write, duplicate rejected, stranger rejected, attached deposit rejected, the owner allows another writer, and the batch fingerprint matches the off-chain check.
- 16 Node unit tests passed: the fingerprint matches `@sycee/core`, the combined fingerprint, the demo page's algorithm, and the deploy script's refusal of mainnet.
- 3 local NEAR sandbox tests passed. They cover the contract sandbox (write, duplicate rejected, stranger rejected, a missing fingerprint reads back empty, attached NEAR rejected, the public log, a batch root equal to the JavaScript root, `verify_inclusion`, and `scripts/verify.mjs` against that local chain), the end-to-end demo, and the restricted-key demo.
- The demo page opens with a sample receipt filled in. With "离线示例" checked, it computes `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03` and shows that this matches the fingerprint written into the page. That step does not contact testnet.
- The same sample receipt is on NEAR testnet. Contract account `sycee-anchor.testnet` (owner `sycee-anchor.testnet`, anchorers `[]`), deployed from commit `01b4e419`, wasm 159146 bytes, sha256 `c027e046864760b51848501cec91c5c0b4e738d6dc94de86ce63d3d0ae98a236`. Deploy transaction: [J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h](https://testnet.nearblocks.io/txns/J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h). The anchor is hash `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`, source chain `eip155:84532`, merchant id `sycee:demo-merchant`, block 277456711. Anchor transaction: [9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ](https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ). `verify.mjs` returned ok.

## What was built during the hackathon

SYCEE's specification and signing code already existed before 2026-10-19, the day the NEAR hackathon was announced. The last commit before that day is [`f1af69d`](https://github.com/ruiruii/sycee/commit/f1af69de1f461d9d656f598473042187e9118db1) (2026-10-12).

The new work is the NEAR piece in `examples/near-anchor/`: the contract, the demo page, the end-to-end demo, and the restricted-key demo. Compare that baseline to `main`:

https://github.com/ruiruii/sycee/compare/f1af69de1f461d9d656f598473042187e9118db1...main

That diff also contains other SYCEE commits that landed on main after 19 October, including the Base Sepolia demo merchant. The NEAR contract itself starts on this line of work. The owner will add the tags `pre-hackathon` and `hackathon-submission`. This repository does not create those tags.

## Libraries, templates and AI-generated code

- `near-sdk` 5.7.1: the contract
- `near-workspaces` and its `near-sandbox` (nearcore 2.6.2): local chain for tests and the default demos
- `near-api-js` 5: signing and sending from the scripts
- `near-cli-rs`: what a person runs to deploy; not an npm dependency
- `wasm-opt` from binaryen: rewrites the wasm so the sandbox can load it
- `@sycee/core` and the demo merchant: existing SYCEE code, treated as the baseline

Most of `examples/near-anchor/` was written with Cursor AI coding agents and reviewed by the team.

## 3-step try it

From the repository root. Each step says what you should see.

1. Install and build.

Node.js 20 or newer, and rustup. `scripts/build.sh` installs Rust 1.86.0. Each block below starts from the clone root, so it still works in a new shell.

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
cd examples/near-anchor
npm install
bash scripts/build.sh
```

You see the wasm size on the last line: `159146`.

2. Run the default end-to-end demo. The payment is simulated. No key and no transfer.

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
npm run demo:e2e
```

You see `payment: SIMULATED`, `payment_note: mock facilitator, no Base Sepolia transfer, no funds moved`, `http_status: 200`, `receipt_hash: sha256:` plus 64 hex characters, `chain: local NEAR sandbox`, `verify: ok true`, and `nearblocks: n/a`.

3. Check the sample receipt that is already on testnet. This is a read. It does not spend and does not need a key.

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
NEAR_CONTRACT_ID=sycee-anchor.testnet node scripts/verify.mjs --receipt fixtures/sample-receipt.json
```

You see JSON with `"ok": true` and `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`.

The demo page accepts the printed block, or only the `receipt_hash` line. A link can be `demo/index.html?hash=sha256:...&tx=https://testnet.nearblocks.io/txns/...&offline=0`. Uncheck "离线示例" to query `sycee-anchor.testnet`. A hash minted in the sandbox is not on testnet. The sample receipt is, at block 277456711.

Optional. Skip this unless you already have the NEAR account. The key is in `~/.near-credentials/testnet/sycee-anchor.testnet.json` or `NEAR_PRIVATE_KEY`. The script does not print it.

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
NEAR_ACCOUNT_ID=sycee-anchor.testnet NEAR_CONTRACT_ID=sycee-anchor.testnet npm run demo:e2e -- --testnet
```

You see `payment: SIMULATED`, `chain: NEAR testnet`, `verify: ok true`, and `nearblocks: https://testnet.nearblocks.io/txns/...`. The `demo_page` line includes `&tx=`.

One testnet run is already recorded. Transaction [6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo](https://testnet.nearblocks.io/txns/6TyCsHwSkwKshGgWGDJPFqrW2WLqrBnpvw3Amy4ppxTo). The receipt hash starts with `sha256:618a3915` (the full 64 hex digits are in that transaction). The payment was still simulated. No Base transfer.

Security demo, local sandbox, no key:

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
npm run demo:security
```

You see `key: function-call`, `methods: anchor,anchor_batch`, `deposit: not allowed`, `anchor_with_limited_key: ok`, `transfer NEAR: rejected`, `add key: rejected`, `call add_anchorer: rejected`, `attached deposit: rejected`, and `duplicate anchor: rejected`.

That key may call only `anchor` and `anchor_batch` on this contract, and may spend gas up to its allowance. It cannot transfer NEAR, attach a deposit, add a key, or call another method. The contract also rejects a duplicate hash, a caller who is not on the list, and an attached deposit.

Optional. Skip this unless you already have the NEAR account. It adds one restricted key to `sycee-anchor.testnet` and spends testnet gas only:

```bash
cd "$(git rev-parse --show-toplevel)/examples/near-anchor"
NEAR_ACCOUNT_ID=sycee-anchor.testnet NEAR_CONTRACT_ID=sycee-anchor.testnet npm run demo:security -- --testnet
```

One testnet run is already recorded. Restricted public key `ed25519:7G1L5eMc5pKCJcVNbHvv68j1THA6bxc9QDFg7sFN4Qjy`. The key was added in [HpZaM37gDbngx7skC1vjk81QFkjb7Yv2jLHN7GGWSLnh](https://testnet.nearblocks.io/txns/HpZaM37gDbngx7skC1vjk81QFkjb7Yv2jLHN7GGWSLnh). That key anchored a receipt in [9u6vfDWwuMdUcyVb3LXDUuotbdQBF68EmbX7Z6oRM8r6](https://testnet.nearblocks.io/txns/9u6vfDWwuMdUcyVb3LXDUuotbdQBF68EmbX7Z6oRM8r6). A second write of the same hash panicked in [234ghPupTc158iY6osT53vBTML823BrGYLgdeNg4dPM6](https://testnet.nearblocks.io/txns/234ghPupTc158iY6osT53vBTML823BrGYLgdeNg4dPM6). Transfer, adding another key, and calling `add_anchorer` were rejected when the access key was checked, so those three failures may not show up on an explorer.

```mermaid
flowchart LR
  agent[Agent]
  merchant[Demo merchant]
  receipt[Signed receipt]
  key[Function-call key]
  near[NEAR anchor]
  page[Verify page]
  agent -->|pay| merchant
  merchant --> receipt
  agent --> key
  key -->|hash only| near
  receipt --> page
  near --> page
```

| Judging area | What we did | Evidence |
|---|---|---|
| Technical implementation | Contract, sandbox, one command | `npm run demo:e2e`, `.github/workflows/near-anchor.yml` |
| Design | Hashes only. No score, no custody | `examples/near-anchor/contract/src/lib.rs` |
| Impact | The sample receipt is readable on testnet | [anchor tx](https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ) |
| Originality | Core predates 19 October; the NEAR piece is new | [compare](https://github.com/ruiruii/sycee/compare/f1af69de1f461d9d656f598473042187e9118db1...main) |
| Sustainability | No custody. The agent key cannot move funds | `npm run demo:security` |

The owner posted these. Nothing is posted from here.

- Demo video: [https://x.com/aking_z/status/2121175474265313681](https://x.com/aking_z/status/2121175474265313681) (2-min, posted as a reply under the demo post).
- Demo post on X: [https://x.com/aking_z/status/2121175201778143394](https://x.com/aking_z/status/2121175201778143394).

Still the owner's, not done here:

- Mainnet payout account: `locallemon5213.near`. The owner created it and it was verified on mainnet. Nothing in this repository is deployed to mainnet, and nothing here moves funds.
- Public demo URL: [https://ruiruii.github.io/sycee/](https://ruiruii.github.io/sycee/) (HTTP 200, deployed from main). The published page reads `hash`, `offline`, and a full nearblocks `tx` URL.

---
