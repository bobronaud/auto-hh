import { test } from 'node:test'
import assert from 'node:assert/strict'
import { salaryAnswer, experienceBand } from '../src/answers/salary.js'

const base = { title: 'Frontend-разработчик', salaryFrom: null, salaryTo: null, currency: null, experience: null }

test('range in the posting wins: upper bound', () => {
  assert.equal(salaryAnswer({ ...base, salaryFrom: 150000, salaryTo: 250000, currency: 'RUR' }), '250 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Senior React', salaryFrom: 90000, salaryTo: 120000 }), '120 000 руб')
})

test('only "от" → that figure; foreign currency keeps its code', () => {
  assert.equal(salaryAnswer({ ...base, salaryFrom: 180000, currency: 'RUR' }), '180 000 руб')
  assert.equal(salaryAnswer({ ...base, salaryTo: 3500, currency: 'USD' }), '3 500 USD')
})

test('senior in the title beats the experience line', () => {
  assert.equal(salaryAnswer({ ...base, title: 'Senior Frontend Developer', experience: '1–3 года' }), '200 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Senior-разработчик Vue' }), '200 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Сеньор фронтенд' }), '200 000 руб')
})

test('middle and senior together → 150-200k', () => {
  assert.equal(salaryAnswer({ ...base, title: 'Middle/Senior Frontend Developer' }), '150 000 - 200 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Middle+/Senior React-разработчик', experience: 'более 6 лет' }), '150 000 - 200 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Frontend-разработчик (Middle / Senior)' }), '150 000 - 200 000 руб')
})

test('junior without middle, or no experience → 100-150k', () => {
  assert.equal(salaryAnswer({ ...base, title: 'Junior Frontend' }), '100 000 - 150 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Джуниор фронтенд-разработчик' }), '100 000 - 150 000 руб')
  assert.equal(salaryAnswer({ ...base, experience: 'не требуется' }), '100 000 - 150 000 руб')
})

test('junior/middle is not junior: falls through to experience', () => {
  assert.equal(salaryAnswer({ ...base, title: 'Junior/Middle Frontend', experience: '1–3 года' }), '150 000 руб')
  assert.equal(salaryAnswer({ ...base, title: 'Junior+ / Middle React' }), '150 000 руб')
})

test('experience bands', () => {
  assert.equal(salaryAnswer({ ...base, experience: '1–3 года' }), '150 000 руб')
  assert.equal(salaryAnswer({ ...base, experience: '3–6 лет' }), '150 000 - 200 000 руб')
  assert.equal(salaryAnswer({ ...base, experience: 'более 6 лет' }), '200 000 руб')
  assert.equal(salaryAnswer(base), '150 000 руб')
})

test('words inside other words do not count', () => {
  assert.equal(salaryAnswer({ ...base, title: 'Seniority Frontend', experience: '1–3 года' }), '150 000 руб')
})

test('experienceBand reads hh wording with any dash', () => {
  assert.equal(experienceBand('Опыт работы: 1–3 года'), '1-3')
  assert.equal(experienceBand('3-6 лет'), '3-6')
  assert.equal(experienceBand('Требуемый опыт работы: не требуется'), 'none')
  assert.equal(experienceBand('более 6 лет'), '6+')
  assert.equal(experienceBand(null), null)
})
