import * as vscode from 'vscode';

const OPERATOR_SETTINGS_KEY = 'agentComms.operatorSettings';

export interface SavedOperatorSettings {
  listenEnabled: boolean;
}

function isSavedOperatorSettings(value: unknown): value is SavedOperatorSettings {
  return typeof value === 'object'
    && value !== null
    && 'listenEnabled' in value
    && typeof value.listenEnabled === 'boolean';
}

export class OperatorSettingsStore {
  constructor(private readonly state: vscode.Memento) {}

  get(): SavedOperatorSettings {
    const raw = this.state.get<unknown>(OPERATOR_SETTINGS_KEY);
    if (isSavedOperatorSettings(raw)) {
      return raw;
    }

    return {
      listenEnabled: false,
    };
  }

  async setListenEnabled(listenEnabled: boolean): Promise<void> {
    await this.state.update(OPERATOR_SETTINGS_KEY, { listenEnabled });
  }
}
