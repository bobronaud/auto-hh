/** Defaults shared by config migration and the CLI adapter. */
export const DEFAULT_TEXT_MODEL = 'gpt-6-luna'
export const DEFAULT_IMAGE_MODEL = 'gpt-6.1-terra'

/** Only legacy Claude configs have their model translated automatically. */
export function migrateLegacyLlm(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const llm = value as Record<string, unknown>
  if (llm.provider !== 'claude-cli') return value
  const model = llm.model
  return {
    ...llm,
    provider: 'codex-cli',
    model: model === undefined || (typeof model === 'string' &&
      (!model.trim() || /^(?:sonnet|opus|haiku)(?:[-.\d].*)?$|^claude-/i.test(model)))
      ? DEFAULT_TEXT_MODEL : model,
  }
}
