/**
 * Pure visibility model for the free-grant claim banner (Settings → Traffic).
 *
 * Product contract: the 50MB claim campaign is visible on a fresh install,
 * and for repeat campaigns the banner stays visible whenever the live balance
 * is below the campaign threshold — even while the server-side claim cooldown
 * is still running (the button disables until nextClaimAt instead of the
 * banner disappearing). Otherwise visibility follows the backend `claimable`
 * flag, and a failed status fetch keeps the banner when the account exists
 * (claim itself is the source of truth for eligibility).
 */

/** Structural subset of TrafficFreeGrantCampaignInfo (TrafficSettings.tsx). */
export type FreeGrantCampaignLike = {
  enabled: boolean;
  claimed: boolean;
  claimable: boolean;
  repeatEnabled?: boolean;
  thresholdBytes?: number;
  nextClaimAt?: number;
};

export type FreeGrantBannerState = {
  /** Render the green banner and the claim button. */
  visible: boolean;
  /**
   * Repeat campaign is active and the live balance is below its threshold
   * (banner copy switches to the personalized repeat wording).
   */
  repeatBelowThreshold: boolean;
  /** Server cooldown lift time in ms while it still blocks the claim; 0 otherwise. */
  cooldownUntil: number;
  /** Server low-balance threshold in bytes while the repeat campaign applies; 0 otherwise. */
  thresholdBytes: number;
};

export type FreeGrantBannerInput = {
  campaign: FreeGrantCampaignLike | null;
  /** Status fetch settled (campaign===null then means the fetch failed). */
  campaignReady: boolean;
  /** Live balance has been loaded; unknown balance never activates the repeat path. */
  hasBalance: boolean;
  balanceBytes: number;
  nowMs: number;
};

export function resolveFreeGrantBanner(input: FreeGrantBannerInput): FreeGrantBannerState {
  const { campaign, campaignReady, hasBalance, balanceBytes, nowMs } = input;
  const thresholdBytes =
    campaign?.repeatEnabled && typeof campaign.thresholdBytes === 'number' && campaign.thresholdBytes > 0
      ? campaign.thresholdBytes
      : 0;
  const repeatBelowThreshold = Boolean(
    campaign?.enabled && campaign.claimed && hasBalance && thresholdBytes > 0 && balanceBytes < thresholdBytes,
  );
  const cooldownUntil =
    repeatBelowThreshold && typeof campaign?.nextClaimAt === 'number' && campaign.nextClaimAt > nowMs
      ? campaign.nextClaimAt
      : 0;
  const visible = campaign
    ? Boolean(campaign.claimable || (!campaign.claimed && campaign.enabled) || repeatBelowThreshold)
    : Boolean(campaignReady && hasBalance);
  return { visible, repeatBelowThreshold, cooldownUntil, thresholdBytes };
}
