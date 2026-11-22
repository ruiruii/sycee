# Reply to holistis — after reading `vectors/attempt-identity-extra`

Same-author reading, 2026-11-22. Companion: `reading-attempt-identity-extra.md`.

## English

Taken, and the label is truer than you may have meant: I read your README first, and the README states the four rules. Without it, three of the four come from RFC 9110 and RFC 6839, and the fourth is a decision none of them makes. One reader, one text, where the text includes the explanation.

The values hold. I wrote a stdlib-only Python implementation from the four rules, without opening `src/canonical-request.mjs`, `interop/python` or `test/`, and it reproduces 4 of 4 right values and 4 of 4 wrong ones. Each wrong value is exactly what its named mistake produces, and each twin carries a byte-identical input, so the pairs test the rule and not the number. All eight match `SHA256SUMS`. The write-up is `upstream/reading-attempt-identity-extra.md` in our repo; I can paste it in here if you would rather not open a link.

Three places where the text and the files part company, in the order I would fix them.

1. `provenance` cites §5.5 alone. The rules are RFC 9110's and RFC 6839's, and §5.5 contains none of them. Your README says so; `provenance` is what a consumer reads without the README. One line per file.

2. `SHA256SUMS` covers the eight JSON and not the README, which is the only place the rules are written. `sha256sum -c` passes while someone rewrites the rules. The 22 have an anchor outside the folder, §5.5 at `2819ed7`; the eight have a README and a tag, and the tag pins a different object than the rule.

3. The charset pair moves two things. The existing file is `\x80A` with a lower-case name; yours is `caf\xe9 \x80` with capitals. A failure here cannot be attributed to case. If you want case alone: same body, `charset=iso-8859-1`, `27d073d0`.

And the correction: that pair is not RFC 2978's. RFC 2978 settles the name, not the mapping, and the mapping has two published answers. WHATWG Encoding makes `iso-8859-1` a label of windows-1252 and says that software following it decodes 0x80 as the euro sign; ICU, which is what Node 22 here uses, returns U+0080. So your plausible mistake is what a browser computes while following a standard. Your value is right for the reading §5.5 wants. The file should say it is choosing, or it will fail a compliant implementation and blame the wrong thing.

On "not nothing": you are right, and I was measuring the wrong thing. I was counting people who had adopted SYCEE; you were counting something that had actually happened. One line worth adding to your own list: the README says the 22 were recomputed by `ruiruii` and `NSPG13`. `ruiruii` is me. One of the two outside recomputes was the person arguing about the label.

On which outside user: the one you already have. Nirium's devlog for 13 August is that story in their own words. A 402 with an empty body to a retry, then the same payment settling thirty seconds later from a different address in the relayer pool, and the caller charged for a request it had been told had failed. That seller does not need persuading that the ambiguity costs money. They have the receipt. If they will let that entry be cited, and run their reconcile endpoint against a refusal row, that is worth more than a stranger who agrees with us.

So: you take the reader who arrives after something went wrong. I will take the seller deciding whether to retry. Same failure, two ends of it.

-- Rachel

## 中文

我收下这个定位，而且它比你可能想说的更准：我先读了你的 README，而四条规则是 README 写出来的。没有它，四条里有三条来自 RFC 9110 和 6839，第四条是这几份文件都不做的一个决定。所以这是一个读者读一份文本，而文本里包含了说明。

值是对的。我用纯标准库写了一个 Python 实现，规则只从那四条来，没有打开 `src/canonical-request.mjs`、`interop/python` 或 `test/`，四个正确值全部复现，四个错误值也全部复现。每个错误值都恰好等于它自己所说的那个错法算出来的结果，而且每个错误孪生的输入与正确孪生逐字节相同——所以这一对对的是规则，不是一个不一样的数。八份文件全部通过 `SHA256SUMS`。详细写在仓库的 `upstream/reading-attempt-identity-extra.md`；你不想开链接的话我可以贴在这里。

三处正文与文件对不上的地方，按我会修的先后排。

1. `provenance` 只写了 §5.5。这四条规则是 RFC 9110 和 RFC 6839 的，§5.5 里一条都没有。你的 README 是这么说的，但 `provenance` 是别人不读 README 时会读的那个字段。每个文件加一行。

2. `SHA256SUMS` 覆盖了八份 JSON，没覆盖 README，而 README 是唯一写着这四条规则的地方。把规则改掉，`sha256sum -c` 照样过。那 22 份在目录外面有个锚：`2819ed7` 的 §5.5。这八份只有一个 README 和一个 tag，而 tag 钉住的是另一个东西。

3. 字符集那一对动了两个变量。已有的那份是 `\x80A` 配小写名；你这份是 `caf\xe9 \x80` 配大写。所以在这份上失败，归不到「大小写」头上。想要只测大小写：同一个 body，`charset=iso-8859-1`，`27d073d0`。

还有你说的那句「我错了就纠正我」——这一对不是 RFC 2978 的。RFC 2978 管的是名字，不是映射，而映射有两个公开答案。WHATWG 编码标准把 `iso-8859-1` 列成 windows-1252 的标签，并写明按它实现的软件会把 0x80 解成欧元符号；ICU（这里 Node 22 用的就是它）返回 U+0080。所以你说的「合理错误」，是浏览器按标准算出来的结果。你的值对 §5.5 要的那种读法是对的。文件该写清它在这里做了一个选择，否则它会判一个合规实现失败，还归错原因。

关于「不是什么都没有」：你是对的，是我量错了东西。我在数有多少人采用了 SYCEE，你在数有多少事真的发生了。有一行值得加进你自己的清单：README 里写着，那 22 份是 `ruiruii` 和 `NSPG13` 复算的。`ruiruii` 是我。两个外部复算里，有一个就是跟你争标签的人。

至于「最想要哪个外部用户」：你已经有的那个。Nirium 八月十三号那篇 devlog 就是这件事，用他们自己的话写的。一次重试收到空 body 的 402，三十秒后同一笔款从 relayer 池里另一个地址落了链，调用方为一次被告知失败了的请求付了钱。那个卖家不需要被说服「歧义是要花钱的」。他手上有账单。如果他愿意让那条记录被引用，并且拿他们的 reconcile 端点跑一行拒绝向，这比一个点头同意的陌生人值钱。

所以：你拿「出事后才来的人」，我拿「正在决定要不要重试的卖家」。同一个故障，两端。

—— Rachel
