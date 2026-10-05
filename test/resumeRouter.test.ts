import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { configSchema } from '../src/config/schema.js'
import { routeResume } from '../src/scoring/resumeRouter.js'

const cfg = configSchema.parse(
  JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')),
)

const route = (title: string, description?: string) => routeResume(cfg, { title, description }).resume.id

test('fullstack and backend vacancies go to the fullstack resume', () => {
  assert.equal(route('Fullstack-разработчик (React/Node)'), 'fullstack')
  assert.equal(route('Full‑Stack разработчик'), 'fullstack')
  assert.equal(route('Веб-разработчик (full-stack)'), 'fullstack')
  assert.equal(route('Backend-разработчик (Node.js)'), 'fullstack')
  assert.equal(route('Fullstack-разработчик', 'Стек: React, TypeScript, NestJS, PostgreSQL'), 'fullstack')
})

test('a frontend title beats backend mentions in the body', () => {
  assert.equal(route('Frontend-разработчик (React)', 'Знание Node.js будет плюсом'), 'react')
  assert.equal(route('Vue-разработчик', 'Бэкенд на Python, FastAPI'), 'vue')
})

test('fallback stays react', () => {
  assert.equal(route('Frontend-разработчик'), 'react')
  assert.equal(route('Frontend-разработчик (React / Vue)'), 'react')
  assert.equal(route('Angular Developer'), 'react')
})
