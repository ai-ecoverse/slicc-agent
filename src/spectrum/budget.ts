import type { BudgetState, SettingsState } from '../services.ts';

export interface Selected {
  provider(): string | undefined;
  onChange(listener: () => void): () => void;
}

export const BUDGET_NAMES: Readonly<Record<string, string>> = { adobe: 'Adobe', xai: 'SuperGrok' };

export const budgetName = (provider: string): string => BUDGET_NAMES[provider] ?? provider;

export function selectedBudget(
  state: SettingsState | undefined,
  provider: string | undefined
): BudgetState | null {
  const budgets = state?.budgets ?? (state?.budget ? [state.budget] : []);
  return budgets.find((budget) => budget.provider === provider) ?? budgets[0] ?? null;
}

export function agentSelection(agent: {
  active(): string;
  list(): readonly { id: string; model: string }[];
  on(type: 'agents' | 'active', listener: () => void): () => void;
}): Selected {
  return {
    provider() {
      const rows = agent.list();
      const row = rows.find((entry) => entry.id === agent.active()) ?? rows[0];
      const model = row?.model ?? '';
      const at = model.indexOf('/');
      return at > 0 ? model.slice(0, at) : undefined;
    },
    onChange(listener) {
      const offs = [agent.on('agents', listener), agent.on('active', listener)];
      return () => {
        for (const off of offs) off();
      };
    },
  };
}
