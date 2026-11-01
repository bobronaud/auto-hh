import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../core/logger.js'
import { DEFAULT_TEXT_MODEL } from '../config/llm.js'
import type { Config } from '../config/schema.js'
import type { CompletionRequest, CompletionResult, LlmProvider } from './provider.js'

const log = logger('llm')
const MAX_OUTPUT = 8 * 1024 * 1024

/** One isolated, non-interactive Codex session per completion; no shell interpolation. */
export class CodexCliProvider implements LlmProvider {
  readonly name = 'codex-cli'
  readonly model: string

  // The executable seam lets tests exercise the real process/stdio lifecycle offline.
  constructor(private readonly cfg: Config, private readonly executable = 'codex') {
    this.model = cfg.llm.model.trim() || DEFAULT_TEXT_MODEL
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = req.images?.length ? this.cfg.llm.imageModel : this.model
    const dir = await mkdtemp(join(tmpdir(), 'auto-hh-codex-'))
    const answerPath = join(dir, 'answer.txt')
    const started = Date.now()
    try {
      const args = [
        '-a', 'never', 'exec',
        '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--color', 'never', '--json',
        '--model', model, '--output-last-message', answerPath,
        '-c', 'forced_login_method="chatgpt"',
        '-c', 'features.shell_tool=false',
        '-c', 'web_search="disabled"',
        '-c', 'project_doc_max_bytes=0',
        // Even ephemeral runs initialize SQLite state. Keep it out of CODEX_HOME.
        '-c', `sqlite_home=${JSON.stringify(dir)}`,
        '-c', `log_dir=${JSON.stringify(join(dir, 'log'))}`,
        '-c', `model_reasoning_effort=${JSON.stringify(this.cfg.llm.reasoningEffort)}`,
        '-c', `developer_instructions=${JSON.stringify(req.system ?? 'Отвечай строго в заданном формате.')}`,
      ]
      for (const [i, img] of (req.images ?? []).entries()) {
        const path = join(dir, `image-${i}.${img.mediaType === 'image/png' ? 'png' : 'jpg'}`)
        await writeFile(path, Buffer.from(img.base64, 'base64'), { mode: 0o600 })
        args.push('--image', path)
      }
      args.push('-')

      const stdout = await this.run(args, req.prompt, dir)
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        let event: { type?: string; usage?: { input_tokens?: number; output_tokens?: number } }
        try { event = JSON.parse(line) } catch { continue }
        if (!event || typeof event !== 'object') continue
        if (event.type === 'turn.failed' || event.type === 'error') {
          throw new Error('Codex CLI сообщил об ошибке запроса; проверьте авторизацию, модель и квоту.')
        }
        if (event.type === 'turn.completed') {
          inputTokens = event.usage?.input_tokens
          outputTokens = event.usage?.output_tokens
        }
      }

      let text: string
      try {
        if ((await stat(answerPath)).size > MAX_OUTPUT) throw new Error('output limit')
        text = (await readFile(answerPath, 'utf8')).trim()
      } catch {
        throw new Error('Codex CLI не создал допустимый файл финального ответа.')
      }
      if (!text) throw new Error('Codex CLI вернул пустой финальный ответ.')
      log.debug(`${model}: ${outputTokens ?? '?'} out tokens, ${((Date.now() - started) / 1000).toFixed(1)}s`)
      return { text, model, inputTokens, outputTokens }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private run(args: string[], prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      const chunks: Buffer[] = []
      let outputBytes = 0
      let diagnostic = ''
      let failure: Error | undefined
      const stop = (error: Error) => {
        failure ??= error
        // Terminate the isolated process group as well as the CLI on POSIX.
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch { child.kill('SIGKILL') }
      }
      const timer = setTimeout(() => stop(new Error(
        `Codex CLI: таймаут ${this.cfg.llm.timeoutSec} с.`,
      )), this.cfg.llm.timeoutSec * 1000)
      const receive = (data: Buffer, keep: boolean) => {
        outputBytes += data.length
        if (outputBytes > MAX_OUTPUT) {
          stop(new Error('Codex CLI превысил ограничение вывода 8 МиБ.'))
        } else if (keep) chunks.push(data)
        else diagnostic = (diagnostic + data.toString('utf8')).slice(-4096)
      }
      child.stdout.on('data', (data: Buffer) => receive(data, true))
      // stderr can include prompts and personal data; never copy it into application logs.
      child.stderr.on('data', (data: Buffer) => receive(data, false))
      child.on('error', (error: NodeJS.ErrnoException) => {
        failure = new Error(error.code === 'ENOENT'
          ? '`codex` не найден в PATH. Установите Codex CLI и выполните codex login.'
          : `Codex CLI не удалось запустить (${error.code ?? 'ошибка процесса'}).`)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (failure) reject(failure)
        else if (code !== 0) {
          // Classify a few useful failures without logging potentially private CLI output.
          const hint = /read-only file system/i.test(diagnostic)
            ? 'Codex CLI не может записать служебные данные. Проверьте разрешения на installation_id и tmp в CODEX_HOME; SQLite и логи используют временный каталог.'
            : /permission denied|operation not permitted/i.test(diagnostic)
              ? 'Доступ запрещён средой выполнения. Проверьте разрешения для запуска CLI и его авторизации.'
              : /unexpected argument|unrecognized (?:option|argument)/i.test(diagnostic)
                ? 'Обновите Codex CLI: установленная версия не поддерживает параметры запуска.'
                : 'Проверьте codex login, доступность модели и квоту.'
          reject(new Error(`Codex CLI завершился с кодом ${code}. ${hint}`))
        } else resolve(Buffer.concat(chunks).toString('utf8'))
      })
      // Early CLI exit is reported by close/error, not an unhandled EPIPE.
      child.stdin.on('error', () => {})
      child.stdin.end(prompt)
    })
  }
}
