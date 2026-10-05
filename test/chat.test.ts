import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatState, type ChatMessage } from '../src/chat/classify.js'
import { interpretReply } from '../src/chat/generate.js'

// The owner's example chat (05.10), cut down.
const LETTER: ChatMessage = { author: 'me', text: 'Здравствуйте! Личный кабинет, которым каждый день пользуются клиенты...' }
const JOINED: ChatMessage = { author: 'system', text: 'Пользователь ИИ-помощник присоединился к чату' }
const GREETING: ChatMessage = {
  author: 'assistant',
  text: 'Здравствуйте, Александр! Я ИИ-помощник hh. Спасибо за отклик на вакансию! ...',
}
const Q1: ChatMessage = { author: 'assistant', text: 'Расскажите, пожалуйста, есть ли у вас опыт разработки на бэкенде?' }
const A1: ChatMessage = { author: 'me', text: 'Да, есть. На текущем месте закрывал смежные backend-задачи на Node.js.' }
const Q2: ChatMessage = { author: 'assistant', text: 'Спасибо за подробный ответ. Скажите, работали ли вы с PHP и фреймворком Laravel?' }
const SUMMARY: ChatMessage = {
  author: 'assistant',
  text: 'В разговоре с кандидатом я узнал:\n- У вас есть опыт разработки на бэкенде? Ответ:\n- Да, есть.',
}
const THANKS: ChatMessage = {
  author: 'assistant',
  text: 'Благодарю за ответы! Представитель работодателя ознакомится с вашим резюме...',
}
const LEFT: ChatMessage = { author: 'system', text: 'Пользователь ИИ-помощник покинул чат' }

test('first question: greeting and question both go in, as one', () => {
  const s = chatState([LETTER, JOINED, GREETING, Q1])
  assert.equal(s.kind, 'question')
  assert.ok(s.kind === 'question' && s.question.includes('Я ИИ-помощник') && s.question.endsWith('на бэкенде?'))
})

test('next question after our answer is only the new one', () => {
  const s = chatState([LETTER, JOINED, GREETING, Q1, A1, Q2])
  assert.deepEqual(s, { kind: 'question', question: Q2.text })
})

test('we spoke last → awaiting', () => {
  assert.deepEqual(chatState([LETTER, JOINED, GREETING, Q1, A1]), { kind: 'awaiting' })
})

test('summary, thanks, left → finished at every step', () => {
  assert.equal(chatState([LETTER, GREETING, Q1, A1, SUMMARY]).kind, 'finished')
  assert.equal(chatState([LETTER, GREETING, Q1, A1, SUMMARY, THANKS]).kind, 'finished')
  assert.equal(chatState([LETTER, GREETING, Q1, A1, SUMMARY, THANKS, LEFT]).kind, 'finished')
})

test('a live recruiter speaking last is left to the owner', () => {
  const s = chatState([LETTER, { author: 'employer', text: 'Добрый день! Когда удобно созвониться?' }])
  assert.deepEqual(s, { kind: 'human', last: 'Добрый день! Когда удобно созвониться?' })
})

test('only our letter → other', () => {
  assert.deepEqual(chatState([LETTER]), { kind: 'other' })
  assert.deepEqual(chatState([]), { kind: 'other' })
})

test('reply: plain answer, tidied', () => {
  const r = interpretReply('###ОТВЕТ###\nДа, работал с Laravel — интегрировал фронт с его REST API.')
  assert.deepEqual(r, { kind: 'reply', text: 'Да, работал с Laravel - интегрировал фронт с его REST API.' })
})

test('reply: unknown and no-reply', () => {
  const u = interpretReply('###НЕ ЗНАЮ###\nучебное заведение не указано')
  assert.equal(u.kind, 'unanswered')
  assert.ok(u.kind === 'unanswered' && u.reason.includes('учебное заведение'))
  assert.deepEqual(interpretReply('###НЕ НУЖНО###'), { kind: 'no_reply' })
})

test('reply: too long or off-format is rejected', () => {
  const long = interpretReply(`###ОТВЕТ###\n${'Да, работал. '.repeat(40)}`)
  assert.ok(long.kind === 'unanswered' && long.reason.includes('длиннее'))
  assert.equal(interpretReply('Да, работал').kind, 'unanswered')
})

test('reply: admitting a gap is rejected', () => {
  const r = interpretReply('###ОТВЕТ###\nС PHP не работал, но быстро освою.')
  assert.equal(r.kind, 'unanswered')
})

// ---------------------------------------------------------------- live markup

import { readFileSync } from 'node:fs'
import { before, after } from 'node:test'
import { chromium, type Browser, type Page } from 'playwright'
import { readThread } from '../src/hh/chat.js'

let browser: Browser
let page: Page
before(async () => {
  browser = await chromium.launch()
  page = await browser.newPage()
})
after(async () => browser.close())

test('readThread on the owner\'s finished chat (Т Плюс, 05.10)', async () => {
  await page.setContent(readFileSync(new URL('./fixtures/chat-open.html', import.meta.url), 'utf8'))
  const v = await readThread(page)

  assert.equal(v.title, 'FullStack-разработчик')
  assert.equal(v.company, 'Т Плюс')
  assert.equal(v.vacancyHhId, '137316685')
  assert.deepEqual(
    v.messages.map((m) => m.author),
    ['me', 'system', 'assistant', 'assistant', 'me', 'assistant', 'me', 'assistant', 'me', 'assistant', 'me',
      'assistant', 'me', 'assistant', 'assistant', 'system'],
  )
  assert.equal(v.messages[0]!.title, 'Отклик на вакансию')
  assert.match(v.messages[0]!.text, /^Здравствуйте! Личный кабинет/)
  assert.match(v.messages[3]!.text, /опыт разработки на бэкенде\?$/)
  assert.equal(v.messages[10]!.text, 'Нет')
  assert.match(v.messages.at(-1)!.text, /покинул чат/)
  assert.equal(chatState(v.messages).kind, 'finished')

  // Cut right after the first question: that is the state a pass has to answer.
  const cut = v.messages.slice(0, 4)
  const s = chatState(cut)
  assert.ok(s.kind === 'question' && s.question.endsWith('на бэкенде?'))
})

test('a rejection is not left to the owner', () => {
  assert.deepEqual(chatState([LETTER, { author: 'employer', text: 'К сожалению...', title: 'Отказ' }]), { kind: 'other' })
})
