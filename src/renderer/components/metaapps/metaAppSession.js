import { buildUseMetaAppPrompt } from './metaAppPresentation.js';
import { i18nService } from '../../services/i18n';

export async function startMetaAppSession({ app, coworkService }) {
  const prompt = buildUseMetaAppPrompt(app, i18nService.getLanguage());
  return coworkService.startSession({ prompt });
}
