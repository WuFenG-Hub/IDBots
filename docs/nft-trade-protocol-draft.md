# MVC NFT Trade Protocol Draft (S2)

Status: draft for review — this file is NOT on-chain. It fixes the message
formats for NFT listing / sale announcements and documents the buy flow for a
buyer bot (AI_Sunny's re-verification playbook is included verbatim).

Host tools delivered in this slice (branch `feat/metabot-nft-transfer`,
commits `3700509e`, `e5e6ed7b`):

| Tool | Direction | Notes |
| --- | --- | --- |
| `wallet_nft_sell` | seller | lists ONE session-bot NFT at `price_sats` (min 22000) |
| `wallet_nft_cancel_sell` | seller | takes the order down; NFT returns to the seller wallet |
| `wallet_nft_buy` | buyer | takes an on-chain order; pays ask price + fees from the buyer wallet |
| `wallet_nft_sell_orders` | read | on-chain sell orders per address (wallet-api `sell/utxo-list`) |

## 1. Two-transaction structure (what every party must know)

All three NftManager trade ops (`sell`, `cancelSell`, `buy`) mint TWO chained
transactions; the signer broadcasts stage 1, then stage 2:

- `sell`: stage 1 funds the sell-contract output (the order itself, ask price
  embedded in its script); stage 2 moves the NFT into the contract address.
  The **order utxo is stage 1's output 0** (`<funding_txid>:0`) — that is the
  txid the wallet-api sell list reports.
- `cancelSell`: stage 1 is the unlock-check tx; stage 2 spends the order utxo
  and returns the NFT to the seller.
- `buy`: stage 1 is the unlock-check tx; stage 2 spends the order utxo, pays
  the seller the ask price, and moves the NFT to the buyer.

Retry policy implemented in `executeMvcNftTrade` (mvcNftService): stage-1
stale-input failures rebuild the pair excluding spent wallet utxos; stage-2
retryable failures re-broadcast the SAME stage-2 hex; a hard stage-2 failure
surfaces the funding txid + preserved stage-2 hex for manual recovery.

## 2. sellUtxo quadruple (mandatory for an explicit cancel/buy)

The contract rebuild inside `createCancelSellTx` / `createBuyTx` requires the
full quadruple — a bare outpoint is NOT enough (`new mvc.Address(undefined)`
throws, captured in the S2 live-fire log):

```
sellUtxo:
  txId:           <64 hex>  # the sell-contract funding tx (order utxo txid)
  outputIndex:    0         # NftManager always places the contract output at vout 0
  sellerAddress:  <mvc addr># seller address (contract parameter)
  price:          <sats>    # ask price in satoshis (contract parameter)
```

Live wire note (mainnet, 2026-10-28): the wallet-api sell list
(`/v4/mvc/address/contract/nft/sell/utxo-list?address=<addr>&net=mainnet`)
answers camelCase rows with NO outputIndex and NO ask price — the tool
derives `outputIndex: 0` from the NftManager convention (cross-checked
on-chain against `open-api-mvc /contract/nft/sell/address/<addr>/utxo`,
`txIndex: 0`) and the ask price travels in ANNOUNCEMENTS (section 3), because
no indexer endpoint exposes it. Buy/cancel signers resolve the price
on-chain from the contract when the caller lets them auto-resolve, but the
explicit quadruple is the recommended path (works even while the order row is
not yet `isReady` in the indexer).

## 3. Announcement message formats (fixed)

Four structured events; every field is machine-checkable on-chain. Satoshis
are the canonical price unit; `price_space` is informational. Txids are plain
64-hex transaction ids. Emit exactly these keys, in this order, so downstream
parsers can split on line starts.

### 3.1 NFT_LISTED (seller → market)

```
NFT_LISTED
seller: <mvc_address>            # seller wallet address
seller_bot: <metabot name>       # announcing bot (informational)
nft:
  token_index: <int>
  name: <series> - <item name>   # e.g. "MetaBot Avatar - Legs 8"
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>                # ask price; min 22000
price_space: <decimal SPACE>     # price_sats / 1e8
sellUtxo: <txid>:<vout>          # order utxo, vout is 0 for library-built orders
listing_txids:
  funding: <64 hex>              # stage-1 tx (carries the order utxo)
  final: <64 hex>                # stage-2 tx (NFT into contract)
status: LISTED
```

### 3.2 NFT_CANCELLED (seller → market)

```
NFT_CANCELLED
seller: <mvc_address>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
sellUtxo: <txid>:<vout>          # the order that was taken down
cancel_txids:
  check: <64 hex>                # stage-1 unlock-check tx
  final: <64 hex>                # stage-2 cancel tx
status: CANCELLED
```

### 3.3 NFT_BOUGHT / NFT_SOLD (buyer and seller each announce their side)

```
NFT_BOUGHT                       # buyer-side announcement
buyer: <mvc_address>
seller: <mvc_address>
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>
buy_txids:
  check: <64 hex>
  final: <64 hex>                # purchase tx (NFT to buyer, price to seller)
status: BOUGHT
```

```
NFT_SOLD                         # seller-side confirmation after the buy confirms
seller: <mvc_address>
buyer: <mvc_address>             # from the counterparty announcement / chain
nft:
  token_index: <int>
  genesis: <40 hex>
  codehash: <40 hex>
price_sats: <int>
sellUtxo: <txid>:<vout>          # the consumed order
status: SOLD
```

Status vocabulary: `LISTED`, `CANCELLED`, `BOUGHT`, `SOLD`. A listing whose
order is consumed by a purchase ends its lifecycle as `SOLD` (seller view) /
`BOUGHT` (buyer view); consumed by a cancel → `CANCELLED`.

## 4. Buyer playbook — wallet_nft_buy (AI_Sunny re-verification)

Precondition: the seller announced an `NFT_LISTED` event (section 3.1). The
live acceptance order is #5421 "MetaBot Avatar - Legs 8" listed by
Builder阿码 at 100000 sats (0.001 SPACE).

Steps for the buying bot (in its own cowork session, using its OWN wallet):

1. Verify the order is open:
   `wallet_nft_sell_orders { "address": "<seller mvc address>" }`
   → expect one row for token_index 5421 with `sellUtxo <txid>:0`.
2. Buy with the explicit quadruple from the announcement (recommended — does
   not depend on the order being flagged ready by the indexer):
   ```
   wallet_nft_buy {
     "genesis": "<40 hex genesis>",
     "codehash": "<40 hex codehash>",
     "token_index": "5421",
     "sell_txid": "<sellUtxo txid from the announcement>",
     "sell_output_index": 0,
     "seller_address": "<seller mvc address>",
     "sell_price_sats": 100000
   }
   ```
   Two txs broadcast (check, then purchase). The tool returns both txids.
3. Verify:
   - `wallet_nft_balance` on the buyer → #5421 present under the buyer's
     address once the txs confirm;
   - `wallet_nft_sell_orders` on the seller address → the order is gone;
   - ask price actually paid = `sell_price_sats` (contract-enforced).
4. Announce `NFT_BOUGHT` (section 3.3) with both txids.

Fee/balance notes for the buyer: the purchase consumes the ask price PLUS
miner fees (two txs, fee tier = the host's global MVC tier); keep a few
thousand sats above the ask price in the buyer wallet. Wallet UTXO limit:
the signer accepts at most 3 funding UTXOs per trade op.

## 5. Live-fire evidence index (S2 acceptance)

All on MVC mainnet, seller = Builder阿码 `1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx`,
token = #5421 MetaBot Avatar - Legs 8 (genesis `005d69cba8c80e6978157e146f998c21288a9d49`,
codehash `e205939ad9956673ce7da9fbd40514b30f66dc35`), ask 100000 sats:

- BEFORE listing: sell/utxo-list → `{"list":[]}` (empty).
- DRILL listing: funding `b6ac746050051cb6b1a4e714420c532608af7ec30562ada87296ae3a80a68133`,
  final `63445f0034877210965c2d72017ff4a5135b8777df2061e1ce823308473a5298`;
  sell list then showed the order (order utxo `b6ac7460…:0`, satoshi 2032).
- DRILL cancel: check `1235c9f13ad68c74022733a4c94fe0fdadd116d5b8b5661505dc222e54f998e6`,
  final `fc6881cddc7f1897ac2159d7b9b0bb9994a38044fb4d1f43ed471d6f7257c43a`
  (confirmed at block 196070); after confirmation the sell list returned to
  `{"list":[]}`. Indexer timing note: the sell row does NOT disappear while
  only the cancel is mempool-resident (broadcast-level spend accepted, list
  lags) — it clears on confirmation. Not a cancel failure.
- ACCEPTANCE listing (left OPEN for the buyer re-verification), following
  format 3.1 verbatim:

```
NFT_LISTED
seller: 1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx
seller_bot: Builder阿码
nft:
  token_index: 5421
  name: MetaBot Avatar - Legs 8
  genesis: 005d69cba8c80e6978157e146f998c21288a9d49
  codehash: e205939ad9956673ce7da9fbd40514b30f66dc35
price_sats: 100000
price_space: 0.00100000
sellUtxo: 6c1d01260ce29e0a0bcbd6814a5d03b51b4b9f8b28cc27d4f2d747e3cab33ea8:0
listing_txids:
  funding: 6c1d01260ce29e0a0bcbd6814a5d03b51b4b9f8b28cc27d4f2d747e3cab33ea8
  final: 431a440abee50487f0fd252eac8573d910eb910c8b8f3817c0dfe2b828e105cb
status: LISTED
```

  Visible in wallet-api sell/utxo-list and cross-checked on open-api-mvc
  (`6c1d0126…:0`, txIndex 0). This order stays OPEN — AI_Sunny takes it with
  `wallet_nft_buy` per section 4.
