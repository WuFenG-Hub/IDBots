# Manual QA Checklist — Traffic Panel (On-Device Walkthrough)

> Branch acceptance walkthrough for the gasfee traffic-ization feature.
> Run the app from the worktree against the **test instance**. No code changes
> needed — the endpoint switch is a UI operation (Advanced section).

- Build under test: branch `feat/gasfee-flow` (worktree `.worktrees/gasfee-flow`)
- Backend test instance: `http://47.76.58.120:7882` (mainnet chain, isolated
  test keys; platform pays the sponsor fees — that is what the pool is for)
- Admin token (for server-side cross-checks): ask ops / see backend handoff
- Estimated time: 30–45 min

## 0. Start the app from the branch

```bash
cd .worktrees/gasfee-flow
npm run dev
```

Notes:

- The app uses your normal IDBots user profile (identity + bots are shared with
  your regular installation). Traffic mode never touches bot wallets; recharging
  is mock (free). All sponsor fees are paid by the platform test pool.
- If you prefer a throwaway profile, do the walkthrough on a test machine or a
  fresh OS user instead.

## 1. Point the app at the test instance

1. Open **Settings → Traffic** (new tab in the sidebar).
   - If you have no user identity yet: expect the guidance card
     ("create your identity first") → create one in the User tab, then return.
2. Scroll to **Advanced**.
   - [ ] Shows the production default endpoint when nothing is configured.
3. Enter `http://47.76.58.120:7882` (**no** `/assist-open-api` suffix — the test
   instance serves at root) → **Save**.
   - [ ] Success feedback; balance area refreshes against the new endpoint.
   - [ ] Type an invalid value (e.g. `ftp://x`) → error, not saved.

## 2. Enable traffic mode + auto binding

1. In **Mode**, select **Traffic**.
   - [ ] Fallback policy cards appear (keep "Fall back to self-pay").
   - [ ] App runs account ensure + binds all local bot addresses; progress and
     result shown ("Bound N addresses").
2. Server cross-check (optional):
   ```bash
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://47.76.58.120:7882/v1/admin/traffic/accounts/<yourGlobalMetaId>
   ```
   - [ ] Account exists; bound addresses == your local bot addresses.

## 3. Recharge (mock payment)

1. **Balance** card shows 0 MB → click **Recharge**.
   - [ ] Pricing table loads: `cny_10_100mb` — ¥10 → 100 MB.
2. Select the plan → confirm.
   - [ ] Mock payment dialog appears, clearly labeled
     "Mock payment (development)".
3. Confirm the mock payment.
   - [ ] State machine progresses (creating → paying → confirming → success).
   - [ ] Balance updates to **100 MB** (100,000,000 bytes in tooltip).
4. Server cross-check: balance via admin API shows the same number; recharge
   order visible in `GET /v1/admin/traffic/recharge-orders`.

## 4. Spend traffic (chat + file)

1. Have two local bots exchange a few **private chat** messages; post in a
   **group chat**; optionally send a small **file**.
   - [ ] Messages send normally; no wallet-balance errors even if a bot wallet
     is empty. (Best tested with a bot whose MVC balance is ~0 — traffic mode
     should make it work anyway.)
2. Back in **Settings → Traffic**:
   - [ ] Balance decreased (each message ≈ 0.3–1 KB; tooltip shows exact bytes).
   - [ ] **Usage** table shows today's row per bot (name mapped, MB + tx count).
   - [ ] **Ledger** lists the spend entries (and the earlier credit).
3. Server cross-check: admin account detail balance matches the panel;
   `usage/daily` rows match.

## 5. Self-pay toggle regression

1. Switch **Mode** back to **Self-pay**.
2. Send another message from a funded bot.
   - [ ] Works; traffic balance does NOT decrease; the bot's own wallet pays.
3. Switch back to **Traffic**.

## 6. Fallback behavior

1. Ask ops to drain the test balance to near-zero via admin negative grant
   (or set balance below the next message size).
2. Send a message with fallback policy = self-pay:
   - [ ] Message still sends (paid by bot wallet); no crash.
3. Switch fallback policy to **Strict**, send again:
   - [ ] Send fails with a clear "insufficient traffic → recharge" style error,
     not a generic failure.
4. Restore policy to self-pay; recharge again (mock) to restore balance.

## 7. Error & edge states

- [ ] Stop network / point Advanced to a dead URL → each panel section shows
  its own error with Retry; app otherwise unaffected.
- [ ] Balance < 5 MB → low-balance bar visible. (Can be arranged via admin
  negative grant.)
- [ ] Advanced → **Reset** → endpoint returns to production default.

## 8. Cleanup

- Advanced → Reset to production (or keep pointing at the test instance while
  branch acceptance continues).
- Mode back to your preference (default self-pay keeps legacy behavior).

## Known limitations (accepted for branch QA)

- Panel copy is English-only (not wired into i18n dictionaries yet).
- Local account/binding cache is not host-partitioned: after switching API
  base, re-run the mode toggle (or ensure/bind) so the account is re-created
  on the new instance.
- usage/daily buckets are UTC (dates may differ from local day).
- mvcSubsidy (dust/reward) always uses the production service by design.

## Recording results

Log each checkbox pass/fail plus screenshots of: pricing cards, mock payment
dialog, balance before/after, usage table, ledger list. File issues in the
project docs (README progress log) and feed backend issues to the
assist-base-service team.
