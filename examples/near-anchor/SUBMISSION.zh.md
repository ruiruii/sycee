# SYCEE 在 NEAR 上留收据指纹

演示页面，打开就能看，不需要钱包：

- 本地文件：[examples/near-anchor/demo/index.html](demo/index.html)
- 公开网址：[待填]（TBD）。主人先在仓库设置里打开 GitHub Pages（来源选 GitHub Actions），再手动运行名为 Demo page 的工作流。跑通之后，页面会出现在 `https://ruiruii.github.io/sycee/`。现在没有这个网址。

英文稿在 [SUBMISSION.en.md](SUBMISSION.en.md)。给主人勾的清单在 [提交清单.md](提交清单.md)。

## 问题

机器帮人付钱，英文里叫 agent payment。付完之后，旁人怎么知道那张收据没有被改过？

SYCEE 已经会开收据。收据的英文名字是 verifiable receipt。演示商家在 Base Sepolia（以太坊的一条测试网）上卖一个测试接口，`GET /v1/base/tip`，价格是 0.001 美元的测试 USDC。付款成功后，商家签一张收据。收据里只有指纹和签名，没有付款原文。

缺的是一个谁都能查的时间记录：这张收据的指纹，在某个时刻被人写下了。我们不给人打分，不保管钱，也不替任何人转账。

## 方案

收据还是在 Base Sepolia 的演示商家那边产生。我们只做一件事：把收据的指纹抄到 NEAR 测试网上。这件事的英文是 cross-chain anchoring。一边出收据，另一边给指纹盖一个带时间的章。

指纹的算法和 SYCEE 自己用的一样。把收据整理成固定格式的 JSON，再做 SHA-256。带前缀写出来是：

`sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`

这是仓库里那张示例收据的指纹，不是一笔已经发生的付款。演示页用同一套算法重算，离线就能对上这串字。

合约里只存指纹、来源链（例如 `eip155:84532`）、商家公开的收款地址、区块高度、时间、以及是谁写进去的。不存收据正文，不存付款原文，不存私人信息。

谁可以写，在部署时定好。其他人只能查。同一条指纹不能写第二次。

## NEAR 上做了什么

合约在 `contract/`。它不收 NEAR，也不转出 NEAR。方法用白话说是这些：

- `new`：部署时设定主人，以及还可以让谁写入。只在一开始用一次。
- `anchor`：写下一条收据指纹。重复的会被拒绝。不在名单上的人会被拒绝。
- `anchor_batch`：一次写下最多 32 条，并算出一个总指纹（把许多指纹再合成一个，英文叫 Merkle root）。总指纹由合约自己算，调用的人不能随便填。
- `get_anchor`：按指纹查询。没有就返回空。
- `is_anchored`：这条指纹在不在。
- `get_batch`：查询某一次批量的总指纹。
- `verify_inclusion`：拿一条指纹和一份对照材料，检查它是不是属于那个总指纹，并且这个合约确实记过那一批。
- `add_anchorer` / `remove_anchorer`：主人增减可以写入的账号。主人自己不能被删掉。
- `get_owner` / `is_anchorer`：查看主人和名单。谁都可以看。

每次写入会打一条公开日志（NEP-297 这种格式）。日志里也只有指纹和标签。

核对分两处。浏览器演示页只重算指纹。Node 脚本 `scripts/verify.mjs` 还会用 SYCEE 的签名检查，再去链上对指纹。链本身不检查签名，也不判断这笔钱付没付成，也不判断买方用没用过结果。

## 结果

下面这些是已经在这台机器上跑过的，不是计划。

- 合约能编译。`bash scripts/build.sh` 得到的 wasm 是 **159146 字节**（`out/sycee_anchor.wasm`）。
- Rust 单元测试 6 个通过（`cargo +1.100.0 test`）：写入、重复拒绝、外人拒绝、拒收转账、主人授权另一个账号、批量总指纹和对照。
- Node 单元测试 11 个通过：指纹和 `@sycee/core` 一致、总指纹、演示页算法、部署脚本拒绝主网。
- 本地 NEAR 沙箱测试 1 个通过。它覆盖：写入、重复拒绝、外人拒绝、查不到时返回空、拒收附带的 NEAR、公开日志、批量总指纹和 JavaScript 算的一致、`verify_inclusion`、以及 `scripts/verify.mjs` 对着这个本地链核对成功。
- 演示页打开就有一张示例收据。勾着「离线示例」时，它算出 `sha256:f296fd15aee336c3d877dab40eec7a6e64f68923d4002807a2433866ab69cf03`，并显示和页内写死的指纹一致。这一步没有连测试网。
- 测试网合约已经部署。账号 `sycee-anchor.testnet`，主人也是这个账号，写入名单是空的。来自提交 `01b4e419`，wasm 159146 字节，sha256 `c027e046864760b51848501cec91c5c0b4e738d6dc94de86ce63d3d0ae98a236`。部署交易：[J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h](https://testnet.nearblocks.io/txns/J14QkoAmZmtNeFrUcjb5BwN1WjhoN4L7QwiQ9YF5zq3h)。
- 同一张示例收据（`fixtures/sample-receipt.json`）已经写上链。指纹就是上面那串，来源链 `eip155:84532`，商家 `sycee:demo-merchant`，区块 277456711。锚定交易：[9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ](https://testnet.nearblocks.io/txns/9WbMG7rgCiX7TNhnhZdSwGvz2xv82HX3oCgbVCdQHxzJ)。`verify.mjs` 返回成功。

还没做、要主人自己做的：

- 主网收款账号：[待填]（TBD）。黑客松表格如果要一个主网账号来领奖，由主人自己填。这里不创建主网账号，也不部署到主网。
- 演示视频：[待填]（TBD）。
- X 上的演示帖：[待填]（TBD）。由主人自己发。这里不发帖。
- 公开演示网址：[待填]（TBD）。见文首。仓库设置没有被改过。
