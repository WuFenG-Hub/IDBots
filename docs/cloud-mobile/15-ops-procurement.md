# 15 — Operations Procurement

**Party:** owner, or whoever the owner assigns. This is not a coding task.
**Register:** the procurement table and the secrets register in
`00-program-plan.md`. This file is the working checklist. **Report to:** the
planning desk, which checks the item off and tells the party that was
blocked.

Nothing secret goes in git, in this file, or in the status note. A finished
item reports an instance id, a domain, or the name of the password-manager
entry. The secret itself stays in the password manager or in the host env
file, as the register says.

M0 and M1 are signed (2026-10-15). Week 1 is the week of 2026-10-14.

## Decide this week

These unblock other lines. The default applies if the owner does not choose
by the date.

| Decision | Needed by | Default |
|----------|-----------|---------|
| Company entity for the SMS signature and the Apple account | 2026-10-17 | The company entity |
| `{APP_DOMAIN}` and the display name | 2026-10-21 | A subdomain of a domain the owner already controls; display name "IDBots" |
| Who receives the alert webhook and who holds the Apple and Android keys | 2026-10-21 | Owner, with a backup in the password manager |

Later, not this week: bundle prices (WS-D proposes two plans; staging uses
¥0.01), invite trial amounts (default is today's free grant and free LLM
quota), first invite batch (default ten, then fifty), privacy policy and
terms (no production launch without them, M3), support-channel link (M3).
ICP filing stays unfiled unless WS-D reports that same-phone 当面付 cannot
be paid.

## Checklist

### This week (lead time is the reason, not staging day)

- [ ] **SMS signature and two templates** (login code, re-verification code).
      Apply 2026-10-16. Approval takes several business days and the
      signature must belong to the company entity. Mainland numbers need
      approval. Blocks real-phone login. Staging uses the fixed code
      `246810` on allowlisted test numbers until this is approved.
- [ ] **Apple Developer Program** (company). Start the D-U-N-S application
      this week. Blocks TestFlight only (M4), not Phase 1.
- [ ] **Domain and DNS.** `app.{APP_DOMAIN}` and `staging.{APP_DOMAIN}` once
      the domain is chosen. A Hong Kong-hosted site does not need ICP filing.
      Blocks WS-C T2 (certificates and the public URL).
- [ ] **Feishu or DingTalk alert webhook.** Blocks WS-C alert delivery, not
      the deploy assets.

### Before staging (M2)

- [ ] **Staging ECS** in `cn-hongkong`: about 4 vCPU / 16 GB, 200 GB encrypted
      ESSD, Ubuntu 24.04. Elastic IP billed by traffic, peak at least
      100 Mbps (the Phase 0 host had 10 Mbps and it was too slow). SSH only
      from the owner's listed IPs. Hand WS-C the instance id and the egress
      IP. Blocks WS-C T2.
- [ ] **Container Registry** in Hong Kong, private namespace `idbots`. Push
      credential into CI, pull credential onto the host. Blocks image publish.
      WS-A and WS-B can build images locally before this exists.
- [ ] **RAM users**, least privilege: SMS send, OSS write, ACR push, ACR pull.
      No root AccessKey on a host.
- [ ] **Alipay merchant.** Already on Metaso. Confirm with WS-D that it can
      take bundle orders, and that the staging ¥0.01 plan is the only live
      plan until the owner sets prices.

### Before production data (M3 and M4)

- [ ] **Production ECS**: 8 vCPU / 32 GB, same shape as `ecs.g8i.2xlarge`,
      encrypted ESSD, same EIP rule. Capacity 58. Buy before M3. Do not buy
      a second host before user 59.
- [ ] **OSS bucket** in Hong Kong for backups: server-side encryption,
      versioning, a lifecycle rule. Blocks WS-C backups (M4).
- [ ] **Android signing keystore.** Owner generates it, stores it offline,
      and puts a backup in the password manager. Blocks the M4 APK.
- [ ] **Privacy policy, terms, and the custodial disclosure.** Legal review
      of mainland users with data stored in Hong Kong. Blocks M5, and the
      login page must link the texts.
- [ ] **Support channel** shown in the app (Feishu or WeChat group link).

## How to report

A short note per finished item: date, what exists, which checklist line, and
where the secret was stored (the location, not the value). The planning desk
forwards the egress IP to WS-D and the staging URL to WS-E.
