import Decimal from 'decimal.js';

const SECTION_DEFS = [
  { key: "nativeAssets", titleKey: "metabotWalletNativeAssets" },
  { key: "mrc20Assets", titleKey: "metabotWalletMrc20Assets" },
  { key: "mvcFtAssets", titleKey: "metabotWalletMvcFtAssets" },
];
function toItems(value) {
  return Array.isArray(value) ? value : [];
}

export function buildWalletAssetsSectionsViewModel({ assets, loading, error }) {
  return {
    sections: SECTION_DEFS.map((section) => {
      const items = toItems(assets?.[section.key]);
      let state = "loaded";
      if (loading) state = "loading";
      else if (error) state = "error";
      else if (items.length === 0) state = "empty";
      return {
        key: section.key,
        titleKey: section.titleKey,
        state,
        items,
      };
    }),
  };
}

export function validateTokenTransferDraft({ amount, receiver, maxDisplayBalance }) {
  const to = String(receiver || "").trim();
  if (!to) return { valid: false, errorKey: "transferReceiverRequired" };

  let amountValue;
  try {
    amountValue = new Decimal(String(amount || "").trim());
  } catch {
    return { valid: false, errorKey: "transferAmountInvalid" };
  }
  if (!amountValue.isFinite() || amountValue.lte(0)) {
    return { valid: false, errorKey: "transferAmountInvalid" };
  }

  const balanceText = String(maxDisplayBalance || "").trim();
  if (balanceText) {
    try {
      const balanceValue = new Decimal(balanceText);
      if (balanceValue.isFinite() && amountValue.gt(balanceValue)) {
        return { valid: false, errorKey: "transferAmountExceedsBalance" };
      }
    } catch {
      // Ignore malformed balance strings and fall back to amount-only validation.
    }
  }

  return { valid: true };
}

export function buildTokenTransferPreviewPayload({
  metabotId,
  kind,
  asset,
  receiver,
  amount,
  feeRate,
}) {
  return {
    kind,
    metabotId,
    asset,
    toAddress: String(receiver || "").trim(),
    amount: String(amount || "").trim(),
    feeRate,
  };
}

export function buildTokenTransferExecutePayload({
  metabotId,
  kind,
  asset,
  receiver,
  amount,
  feeRate,
}) {
  return buildTokenTransferPreviewPayload({
    metabotId,
    kind,
    asset,
    receiver,
    amount,
    feeRate,
  });
}
