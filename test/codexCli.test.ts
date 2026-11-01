import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexCliProvider } from '../src/llm/codexCli.js'
import { configSchema, type Config } from '../src/config/schema.js'
import { createProvider } from '../src/llm/provider.js'
import { migrateLegacyLlm, DEFAULT_TEXT_MODEL, DEFAULT_IMAGE_MODEL } from '../src/config/llm.js'

const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'))
const root = mkdtempSync(join(tmpdir(), 'codex-cli-test-'))
const executable = join(root, 'fake-codex')

before(() => {
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = flag => args[args.indexOf(flag) + 1];
const input = fs.readFileSync(0, 'utf8');
{
  const req = JSON.parse(input);
  const images = args.flatMap((arg, i) => arg === '--image' ? [args[i + 1]] : []);
  const report = {cwd: process.cwd(), args, input, images: images.map(path => ({path, data: fs.readFileSync(path).toString('base64')}))};
  if (req.report) fs.writeFileSync(req.report, JSON.stringify(report));
  if (req.mode === 'timeout') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); }
  if (req.mode === 'overflow') { fs.writeSync(1, 'x'.repeat(9 * 1024 * 1024)); process.exit(0); }
  if (req.mode === 'permission') { fs.writeSync(2, 'Permission denied: synthetic confidential path'); process.exit(1); }
  if (req.mode === 'readonly') { fs.writeSync(2, 'failed to initialize in-process app-server client: Read-only file system (os error 30), synthetic confidential path'); process.exit(1); }
  if (req.mode === 'old-cli') { fs.writeSync(2, 'unexpected argument --ignore-user-config'); process.exit(2); }
  if (req.mode === 'exit') { fs.writeSync(2, 'synthetic confidential diagnostic'); process.exit(7); }
  if (req.mode === 'missing') process.exit(0);
  fs.writeFileSync(at('--output-last-message'), req.inspect ? JSON.stringify(report) : (req.answer ?? ''));
  fs.writeSync(1, JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'INTERMEDIATE'}}) + '\\n');
  fs.writeSync(1, 'not json\\nnull\\n');
  if (req.mode === 'failed') fs.writeSync(1, JSON.stringify({type:'turn.failed', error:{message:'failed'}}) + '\\n');
  if (req.mode === 'error') fs.writeSync(1, JSON.stringify({type:'error',message:'failed'}) + '\\n');
  fs.writeSync(1, JSON.stringify({type:'turn.completed',usage:{input_tokens:123,output_tokens:45}}) + '\\n');
}
`)
  chmodSync(executable, 0o700)
})
after(() => rmSync(root, { recursive: true, force: true }))

function config(): Config { return configSchema.parse(base) }

test('CLI: stdin is literal, system instructions are separate, process is isolated and cleaned', async () => {
  const cfg = config()
  const system = 'Строго по формату.\nКавычки " и \\; $(touch unsafe) `unsafe`'
  const prompt = JSON.stringify({ inspect: true, arbitrary: 'Кириллица\n$(touch unsafe) `unsafe`' })
  const result = await new CodexCliProvider(cfg, executable).complete({ system, prompt })
  const report = JSON.parse(result.text)
  assert.equal(report.input, prompt)
  assert.equal(report.args[0], '-a')
  assert.equal(report.args[1], 'never')
  for (const flag of ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json']) {
    assert.ok(report.args.includes(flag), flag)
  }
  assert.equal(report.args[report.args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(report.args.includes(`developer_instructions=${JSON.stringify(system)}`))
  assert.ok(report.args.includes(`sqlite_home=${JSON.stringify(report.cwd)}`))
  assert.ok(report.args.includes(`log_dir=${JSON.stringify(join(report.cwd, 'log'))}`))
  for (const flag of ['features.shell_tool=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'forced_login_method="chatgpt"']) {
    assert.ok(report.args.includes(flag), flag)
  }
  assert.equal(report.args.at(-1), '-')
  assert.equal(existsSync(report.cwd), false)
  assert.equal(result.model, DEFAULT_TEXT_MODEL)
  assert.equal(result.inputTokens, 123)
  assert.equal(result.outputTokens, 45)
})

test('CLI: only the final file is returned, without intermediate messages', async () => {
  const result = await new CodexCliProvider(config(), executable).complete({
    prompt: JSON.stringify({ answer: '  ###ОТВЕТ###\nГотов обсудить.  ' }),
  })
  assert.equal(result.text, '###ОТВЕТ###\nГотов обсудить.')
})

test('CLI: explicit model and reasoning effort are honored', async () => {
  const cfg = config()
  cfg.llm.model = 'custom-model'
  cfg.llm.reasoningEffort = 'low'
  const result = await new CodexCliProvider(cfg, executable).complete({ prompt: '{"inspect":true}' })
  const { args } = JSON.parse(result.text)
  assert.equal(result.model, 'custom-model')
  assert.equal(args[args.indexOf('--model') + 1], 'custom-model')
  assert.ok(args.includes('model_reasoning_effort="low"'))
})

test('CLI: PNG and JPEG attach as files, use the image model and are removed', async () => {
  const data = Buffer.from('synthetic image bytes').toString('base64')
  const result = await new CodexCliProvider(config(), executable).complete({
    prompt: '{"inspect":true}',
    images: [{ mediaType: 'image/png', base64: data }, { mediaType: 'image/jpeg', base64: data }],
  })
  const report = JSON.parse(result.text)
  assert.equal(result.model, DEFAULT_IMAGE_MODEL)
  assert.equal(report.images.length, 2)
  assert.ok(report.images[0].path.endsWith('.png'))
  assert.ok(report.images[1].path.endsWith('.jpg'))
  for (const image of report.images) {
    assert.equal(image.data, data)
    assert.equal(existsSync(image.path), false)
  }
})

for (const mode of ['exit', 'missing', 'failed', 'error', 'empty', 'timeout', 'overflow', 'permission', 'readonly', 'old-cli']) {
  test(`CLI: ${mode} fails and removes its temporary directory`, async () => {
    const cfg = config()
    if (mode === 'timeout') cfg.llm.timeoutSec = 1
    const reportPath = join(root, `${mode}.json`)
    await assert.rejects(new CodexCliProvider(cfg, executable).complete({
      prompt: JSON.stringify({ mode, report: reportPath, answer: mode === 'empty' ? '  ' : 'partial answer' }),
    }), (error: Error) => {
      assert.match(error.message, /Codex CLI/)
      assert.ok(!error.message.includes('synthetic confidential'))
      if (mode === 'permission') assert.match(error.message, /Доступ запрещён/)
      if (mode === 'readonly') assert.match(error.message, /installation_id и tmp/)
      if (mode === 'old-cli') assert.match(error.message, /Обновите Codex CLI/)
      if (mode === 'timeout') assert.match(error.message, /таймаут/)
      if (mode === 'overflow') assert.match(error.message, /8 МиБ/)
      return true
    })
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    assert.equal(existsSync(report.cwd), false)
  })
}

test('CLI: missing executable gives installation guidance', async () => {
  await assert.rejects(new CodexCliProvider(config(), join(root, 'absent')).complete({ prompt: 'hello' }), /codex.*PATH/)
})

test('config: old provider and Claude models normalize to Codex without changing other settings', () => {
  for (const model of ['', 'sonnet', 'opus', 'haiku', 'sonnet-4-5', 'claude-sonnet-4-5', undefined]) {
    const llm = { ...base.llm, provider: 'claude-cli', model, timeoutSec: 333, maxConcurrency: 3 }
    const cfg = configSchema.parse({ ...base, llm })
    assert.equal(cfg.llm.provider, 'codex-cli')
    assert.equal(cfg.llm.model, DEFAULT_TEXT_MODEL)
    assert.equal(cfg.llm.timeoutSec, 333)
    assert.equal(cfg.llm.maxConcurrency, 3)
    assert.deepEqual(cfg.profile, config().profile)
    assert.equal(createProvider(cfg).name, 'codex-cli')
    assert.equal(llm.provider, 'claude-cli')
  }
})

test('config: preserve explicit non-Claude model; only migrate legacy provider', () => {
  assert.deepEqual(migrateLegacyLlm({ provider: 'claude-cli', model: 'custom' }), { provider: 'codex-cli', model: 'custom' })
  assert.deepEqual(migrateLegacyLlm({ provider: 'none', model: 'sonnet' }), { provider: 'none', model: 'sonnet' })
  const cfg = configSchema.parse({ ...base, llm: { provider: 'codex-cli' } })
  assert.equal(new CodexCliProvider(cfg).model, DEFAULT_TEXT_MODEL)
  assert.equal(cfg.llm.imageModel, DEFAULT_IMAGE_MODEL)
  assert.equal(cfg.llm.reasoningEffort, 'medium')
  assert.equal(configSchema.safeParse({ ...base, llm: { reasoningEffort: 'ultra' } }).success, false)
})
