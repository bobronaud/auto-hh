/** One question of an employer's form, as read from the page. */
export interface FormQuestion {
  /** 1-based, the number the model sees. */
  index: number
  text: string
  kind: 'text' | 'radio' | 'checkbox'
  /**
   * The `name` the answer goes into: the textarea for 'text', the input group for
   * radio/checkbox. hh's own stable ids (task_<id>), not positions.
   */
  field: string
  options: FormOption[]
  /** textarea behind a "Свой вариант" option, when the question has one. */
  openField: string | null
}

export interface FormOption {
  value: string
  label: string
}

export type FormAnswer =
  | { kind: 'text'; text: string }
  /** `values` are option values; `text` fills the "Свой вариант" field when chosen. */
  | { kind: 'choice'; values: string[]; text: string | null }

/** Value hh gives the "Свой вариант" option of a choice question. */
export const OPEN_OPTION_VALUE = 'open'

/** The longest answer the owner allows for a single question. */
export const ANSWER_MAX_CHARS = 300
