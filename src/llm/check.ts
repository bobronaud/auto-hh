import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { configSchema } from '../config/schema.js'
import { loadConfig } from '../config/load.js'
import { generateLetters } from '../letters/generate.js'
import { answerForm } from '../answers/generate.js'
import { answerChat } from '../chat/generate.js'
import { classifyEmployerMessage } from '../chat/employer.js'
import { CAPTCHA_SYSTEM, captchaPrompt, parseCaptchaAnswer } from '../hh/captcha.js'
import { createProvider } from './provider.js'

/** Explicit, quota-consuming integration check. No database, hh session or hh requests. */
async function main(): Promise<void> {
  const cfg = configSchema.parse(JSON.parse(await readFile(new URL('../../config.example.json', import.meta.url), 'utf8')))
  // Only provider settings come from the owner's config; all candidate data is synthetic.
  cfg.llm = loadConfig().llm
  assert.equal(cfg.llm.provider, 'codex-cli', 'Проверка требует llm.provider=codex-cli')
  const dir = await mkdtemp(join(tmpdir(), 'auto-hh-llm-check-'))
  try {
    const resume = { id: 'synthetic', title: 'Frontend Developer', match: ['react'], exclude: [], file: join(dir, 'resume.md') }
    await writeFile(resume.file, 'Тестовый кандидат. Frontend-разработчик. Три года разрабатывал интерфейсы на React и TypeScript. Писал компонентные тесты, работал с REST API и Git.', { mode: 0o600 })
    cfg.profile.facts = ['Город: Москва.', 'Предпочтительный формат работы: удалённо.']
    cfg.letter.extraSkills = ''
    const provider = createProvider(cfg)
    console.log(`Проверка Codex на синтетических данных: текст ${provider.model}, изображения ${cfg.llm.imageModel}.`)

    const letters = await generateLetters([
      { index: 1, title: 'React-разработчик', company: 'Тестовая компания A', description: 'React, TypeScript, интерфейсы для аналитики и компонентные тесты.' },
      { index: 2, title: 'Frontend-разработчик', company: 'Тестовая компания B', description: 'React, TypeScript, интеграция REST API и интерфейс каталога.' },
    ], resume, cfg, provider)
    assert.equal(letters.length, 2)
    for (const letter of letters) assert.ok(letter.ok, `Письмо ${letter.index}: ${letter.problems.join('; ')}`)
    console.log('OK: пачка писем прошла действующую валидацию.')

    const vacancy = { title: 'React-разработчик', company: 'Тестовая компания', description: 'Разработка интерфейсов на React и TypeScript.' }
    const form = await answerForm({
      resume, vacancy, salary: '160 000 руб',
      questions: [
        { index: 1, text: 'С какими frontend-технологиями вы работали?', kind: 'text', field: 'q1', options: [], openField: null },
        { index: 2, text: 'Какой формат работы вы предпочитаете?', kind: 'radio', field: 'q2', options: [{ value: 'remote', label: 'Удалённо' }, { value: 'office', label: 'Офис' }], openField: null },
      ],
    }, cfg, provider)
    assert.ok(form.ok, form.ok ? '' : form.reason)
    assert.deepEqual(form.answers.get(2), { kind: 'choice', values: ['remote'], text: null })
    console.log('OK: анкета с текстом и выбором варианта.')

    const chat = await answerChat({ resume, vacancy, salary: '160 000 руб', messages: [{ author: 'assistant', text: 'Какой формат работы вы предпочитаете?' }] }, cfg, provider)
    assert.equal(chat.kind, 'reply', 'Ожидался ответ на вопрос бота')
    if (chat.kind === 'reply') assert.match(chat.text, /удал[её]н/iu)
    console.log('OK: ответ боту прошёл действующую валидацию.')

    const mailing = await classifyEmployerMessage('Резюме получено. Рассмотрим его и свяжемся с вами.', cfg, provider)
    assert.equal(mailing.auto, true, mailing.reason)
    const recruiter = await classifyEmployerMessage('Приглашаем на собеседование завтра в 15:00. Подтвердите удобное время.', cfg, provider)
    assert.equal(recruiter.auto, false, recruiter.reason)
    console.log('OK: рассылка и приглашение рекрутера различаются.')

    const browser = await chromium.launch({ headless: true })
    let image: Buffer
    try {
      const page = await browser.newPage({ viewport: { width: 240, height: 80 } })
      await page.setContent('<body style="margin:0;background:white;color:black;font:40px monospace;padding:16px">AB12</body>')
      image = await page.screenshot({ type: 'png' })
    } finally { await browser.close() }
    const result = await provider.complete({ system: CAPTCHA_SYSTEM, prompt: captchaPrompt(), images: [{ mediaType: 'image/png', base64: image.toString('base64') }] })
    assert.equal(parseCaptchaAnswer(result.text)?.toLowerCase(), 'ab12')
    console.log('OK: изображение с известным текстом. Все проверки завершены; hh не вызывался.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch((error: Error) => {
  console.error(`Проверка LLM не пройдена: ${error.message}`)
  process.exitCode = 1
})
