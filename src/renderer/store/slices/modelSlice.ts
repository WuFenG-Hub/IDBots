import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { defaultConfig, type ModelOptions } from '../../config';

export interface Model {
  id: string;
  name: string;
  provider?: string; // 模型所属的提供商（显示名）
  /** 原始 provider key（'deepseek'/'opencode'/...），用于记录默认 provider 选择。 */
  providerKey?: string;
  supportsImage?: boolean;
  options?: ModelOptions;
}

// 从 providers 配置中构建初始可用模型列表
function buildInitialModels(): Model[] {
  const models: Model[] = [];
  if (defaultConfig.providers) {
    Object.entries(defaultConfig.providers).forEach(([providerName, config]) => {
      if (config.enabled && config.models) {
        config.models.forEach(model => {
          models.push({
            id: model.id,
            name: model.name,
            provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
            providerKey: providerName,
            supportsImage: model.supportsImage ?? false,
            options: model.options,
          });
        });
      }
    });
  }
  return models.length > 0 ? models : defaultConfig.model.availableModels;
}

// 初始可用模型列表（会在运行时更新）
export let availableModels: Model[] = buildInitialModels();

interface ModelState {
  selectedModel: Model;
  availableModels: Model[];
}

const initialState: ModelState = {
  // 使用 config 中的默认模型；同 id 模型多家提供时优先 defaultProvider 指向的那家
  selectedModel: availableModels.find(
    model => model.id === defaultConfig.model.defaultModel
      && model.providerKey === defaultConfig.model.defaultProvider
  ) || availableModels.find(model => model.id === defaultConfig.model.defaultModel) || availableModels[0],
  availableModels: availableModels,
};

const modelSlice = createSlice({
  name: 'model',
  initialState,
  reducers: {
    setSelectedModel: (state, action: PayloadAction<Model>) => {
      state.selectedModel = action.payload;
    },
    setAvailableModels: (state, action: PayloadAction<Model[]>) => {
      state.availableModels = action.payload;
      // 更新导出的 availableModels
      availableModels = action.payload;
      // 同步选中模型信息，确保名称与最新配置一致；同 id 模型多家提供时
      // 优先保持当前 providerKey 指向的那家，避免刷新后跳到别家。
      if (action.payload.length > 0) {
        const matchedModel = state.selectedModel.providerKey
          ? action.payload.find(m => m.id === state.selectedModel.id && m.providerKey === state.selectedModel.providerKey)
            ?? action.payload.find(m => m.id === state.selectedModel.id)
          : action.payload.find(m => m.id === state.selectedModel.id);
        if (matchedModel) {
          state.selectedModel = matchedModel;
        } else {
          // 如果当前选中的模型不在新的可用模型列表中，选择第一个可用模型
          state.selectedModel = action.payload[0];
        }
      }
    },
  },
});

export const { setSelectedModel, setAvailableModels } = modelSlice.actions;
export default modelSlice.reducer; 
