import type { MetabotStore } from '../metabotStore';
import type { MetabotWalletAssets } from './metabotWalletAssetService';
import type {
  TokenTransferDraftInput,
  TokenTransferPreview,
} from './metabotTokenTransferService';

type RegisterIpcHandlerFn = (channel: string, handler: (event: any, ...args: any[]) => any) => void;

interface RegisterMetabotWalletIpcHandlersDeps {
  registerIpcHandler: RegisterIpcHandlerFn;
  getMetabotStore: () => MetabotStore;
  getMetabotWalletAssets: (store: MetabotStore, input: { metabotId: number }) => Promise<MetabotWalletAssets>;
  getTokenTransferFeeSummary: (kind: 'mrc20' | 'mvc-ft') => Promise<{ list: Array<{ title: string; desc: string; feeRate: number }>; defaultFeeRate: number }>;
  buildTokenTransferPreview: (input: TokenTransferDraftInput) => Promise<TokenTransferPreview> | TokenTransferPreview;
  executeTokenTransfer: (store: MetabotStore, input: TokenTransferDraftInput) => Promise<{
    txId: string;
    commitTxId?: string;
    revealTxId?: string;
    rawTx?: string;
  }>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

export function registerMetabotWalletIpcHandlers(deps: RegisterMetabotWalletIpcHandlersDeps): void {
  deps.registerIpcHandler('idbots:getMetabotWalletAssets', async (_event, input: { metabotId: number }) => {
    try {
      const assets = await deps.getMetabotWalletAssets(deps.getMetabotStore(), input);
      return { success: true, assets };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  deps.registerIpcHandler('idbots:getTokenTransferFeeSummary', async (_event, input: { kind: 'mrc20' | 'mvc-ft' }) => {
    try {
      const summary = await deps.getTokenTransferFeeSummary(input.kind);
      return { success: true, ...summary };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  deps.registerIpcHandler('idbots:buildTokenTransferPreview', async (_event, input: TokenTransferDraftInput) => {
    try {
      const preview = await deps.buildTokenTransferPreview(input);
      return { success: true, preview };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  deps.registerIpcHandler('idbots:executeTokenTransfer', async (_event, input: TokenTransferDraftInput) => {
    try {
      const result = await deps.executeTokenTransfer(deps.getMetabotStore(), input);
      return { success: true, result };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}
