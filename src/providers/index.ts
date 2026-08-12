import type { Provider, ProviderName } from '../core/types.js';
import { llmProvider } from './llm.js';
import { mockProvider } from './mock.js';

const registry: Record<ProviderName, Provider> = {
  mock: mockProvider,
  llm: llmProvider,
};

export function getProvider(name: ProviderName): Provider {
  return registry[name];
}
