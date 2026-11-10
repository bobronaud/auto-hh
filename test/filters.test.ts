import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { configSchema } from '../src/config/schema.js'
import { applyFilters } from '../src/scoring/filters.js'
import type { ScrapedCard } from '../src/hh/search.js'

const cfg = configSchema.parse(
  JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')),
)
const card: ScrapedCard = {
  hhId: '123',
  url: 'https://hh.ru/vacancy/123',
  title: 'Frontend React Developer',
  company: 'Example',
  canApplyFromList: true,
  alreadyAppliedOnHh: false,
}

test('Runforge is excluded from collection in every available text field regardless of case or config', () => {
  const cards: ScrapedCard[] = [
    { ...card, title: 'Frontend Developer (Runforge)' },
    { ...card, company: 'ООО RUNFORGE' },
    { ...card, snippet: 'Команда RunForge ищет разработчика' },
    { ...card, searchText: 'Frontend React Developer — продукт runforge.io' },
  ]
  const result = applyFilters(cards, {
    ...cfg,
    filters: { skipWithTest: false, companyBlacklist: [], titleBlacklist: [] },
  }, new Set())
  assert.deepEqual(result.kept, [])
  assert.equal(result.dropped.length, cards.length)
  assert.deepEqual(result.counts, { forbidden_keyword: cards.length })
})

test('collection keeps ordinary frontend vacancies when Runforge is absent', () => {
  const result = applyFilters([card, { ...card, company: null, searchText: '' }], cfg, new Set())
  assert.equal(result.kept.length, 2)
  assert.deepEqual(result.dropped, [])
})
