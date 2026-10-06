import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretAnswers, parseBlocks, describeAnswer, textProblem } from '../src/answers/generate.js'
import type { FormQuestion } from '../src/answers/types.js'

const text: FormQuestion = { index: 1, text: 'Опыт с Vue?', kind: 'text', field: 'task_1_text', options: [], openField: null }
const radio: FormQuestion = {
  index: 2,
  text: 'Готовы к переезду?',
  kind: 'radio',
  field: 'task_2',
  options: [
    { value: '21', label: 'Да' },
    { value: '22', label: 'Нет' },
    { value: 'open', label: 'Свой вариант' },
  ],
  openField: 'task_2_text',
}
const box: FormQuestion = {
  index: 3,
  text: 'Какие инструменты?',
  kind: 'checkbox',
  field: 'task_3',
  options: [
    { value: '31', label: 'Cursor' },
    { value: '32', label: 'Copilot' },
  ],
  openField: null,
}

test('parses answer and unknown blocks, multi-line bodies', () => {
  const b = parseBlocks('###ОТВЕТ 1###\nстрока\nвторая\n\n###НЕ ЗНАЮ 2### нет данных\n')
  assert.deepEqual(b.get(1), { unknown: false, body: 'строка\nвторая' })
  assert.deepEqual(b.get(2), { unknown: true, body: 'нет данных' })
})

test('a full valid reply maps numbers to option values', () => {
  const r = interpretAnswers('###ОТВЕТ 1###\nПисал на Vue 3 три года.\n###ОТВЕТ 2###\n1\n###ОТВЕТ 3###\n1, 2', [text, radio, box])
  assert.ok(r.ok)
  assert.deepEqual(r.answers.get(2), { kind: 'choice', values: ['21'], text: null })
  assert.deepEqual(r.answers.get(3), { kind: 'choice', values: ['31', '32'], text: null })
  assert.equal(describeAnswer(box, r.answers.get(3)!), 'Cursor; Copilot')
})

test('own variant carries its text from the next line', () => {
  const r = interpretAnswers('###ОТВЕТ 2###\n3\nГотов, если будет релокация', [radio])
  assert.ok(r.ok)
  assert.deepEqual(r.answers.get(2), { kind: 'choice', values: ['open'], text: 'Готов, если будет релокация' })
})

test('em dash is repaired, not rejected', () => {
  const r = interpretAnswers('###ОТВЕТ 1###\nДа — три года', [text])
  assert.ok(r.ok)
  assert.deepEqual(r.answers.get(1), { kind: 'text', text: 'Да - три года' })
})

test('any problem fails the whole form, with the question named', () => {
  const cases: Array<[string, FormQuestion[], RegExp]> = [
    ['###НЕ ЗНАЮ 1###\nник в телеграме не указан', [text], /не знает ответа.*телеграме/],
    ['###ОТВЕТ 2###\n1, 2', [radio], /нужен один/],
    ['###ОТВЕТ 2###\n7', [radio], /варианта 7 нет/],
    ['###ОТВЕТ 2###\n3', [radio], /Свой вариант/],
    [`###ОТВЕТ 1###\n${'а'.repeat(301)}`, [text], /длиннее 300/],
    ['###ОТВЕТ 1###\nНе работал с Vue, но быстро освою', [text], /признаётся/],
    ['###ОТВЕТ 1###\nок', [text, radio], /вопрос 2.*не ответила/],
  ]
  for (const [reply, qs, re] of cases) {
    const r = interpretAnswers(reply, qs)
    assert.equal(r.ok, false, reply)
    if (!r.ok) assert.match(r.reason, re)
  }
})

test('textProblem catches a word mixing Cyrillic and Latin (06.10)', () => {
  assert.match(textProblem('Результат проверяю сам: читаю диff, гоняю тесты.') ?? '', /кириллица и латиница/)
  assert.equal(textProblem('Опыт JS-разработчика на Vue 3 и TypeScript, ревью диффов.'), null)
})
