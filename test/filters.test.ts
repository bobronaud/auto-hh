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

test('configured search exclusions are enforced in every available text field regardless of case', () => {
  const cards: ScrapedCard[] = [
    { ...card, title: 'Frontend Developer (BlockedExample)' },
    { ...card, company: 'ООО BLOCKEDEXAMPLE' },
    { ...card, snippet: 'Команда BlockedExample ищет разработчика' },
    { ...card, searchText: 'Frontend React Developer — продукт blockedexample.test' },
  ]
  const result = applyFilters(cards, {
    ...cfg,
    search: { ...cfg.search, excludedText: [' BlockedExample '] },
    filters: { skipWithTest: false, companyBlacklist: [], titleBlacklist: [] },
  }, new Set())
  assert.deepEqual(result.kept, [])
  assert.equal(result.dropped.length, cards.length)
  assert.deepEqual(result.counts, { forbidden_keyword: cards.length })
})

test('collection keeps ordinary frontend vacancies when exclusions are absent', () => {
  const result = applyFilters([card, { ...card, company: null, searchText: '' }], cfg, new Set())
  assert.equal(result.kept.length, 2)
  assert.deepEqual(result.dropped, [])
})

test('empty exclusions are ignored and removing an exclusion allows the vacancy again', () => {
  const cards = [{ ...card, company: 'BlockedExample' }]
  const result = applyFilters(cards, {
    ...cfg,
    search: { ...cfg.search, excludedText: ['', '   '] },
  }, new Set())
  assert.deepEqual(result.kept, cards)
  assert.deepEqual(result.dropped, [])
})
