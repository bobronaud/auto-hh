import { useEffect, useState } from 'react'

export const shortTime = (iso: string): string => new Date(iso).toLocaleTimeString('ru-RU')
export const dateTime = (iso: string): string =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>
}

/**
 * Every table in the app loads the same way: fetch on mount, refetch when the live
 * bus says something changed. Keeping that in one place is what stops the five tabs
 * from each inventing their own loading state.
 */
export function useFetch<T>(load: () => Promise<T>, deps: unknown[]): {
  data: T | null
  error: string | null
  reload: () => void
} {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    load()
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  return { data, error, reload: () => setTick((t) => t + 1) }
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="notice danger">{error}</div>
}

/** hh vacancy link, always opened in a new tab: the queue is the thing being worked. */
export function VacancyLink({ url, title }: { url: string; title: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {title}
    </a>
  )
}

/**
 * Escape closes, the page behind stops scrolling.
 *
 * Shared by every overlay so they cannot drift apart: an overlay that closes on a
 * click outside but not on Escape is the one that traps you.
 */
function useDismiss(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // On window, not on the node: Escape has to work wherever the focus happens to be.
    window.addEventListener('keydown', onKey)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
    }
  }, [onClose])
}

/**
 * Text over the page: a cover letter, read in passing while scanning the history.
 *
 * Closing is deliberately forgiving — Escape, the ✕, or a click anywhere off the
 * card — because nothing here is being edited and there is nothing to lose by
 * closing it. The click handler sits on the backdrop and the card stops propagation,
 * so selecting the text inside does not dismiss it mid-sentence.
 */
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
  onClose: () => void
  /** Room for two columns side by side. */
  wide?: boolean
}) {
  useDismiss(onClose)

  return (
    <div className="modal" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className={wide ? 'modal-card wide' : 'modal-card'} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{title}</strong>
            {subtitle && <div className="dim">{subtitle}</div>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-hint dim">Escape или клик мимо — закрыть</div>
      </div>
    </div>
  )
}

/**
 * Full-size screenshot over the page.
 *
 * A screenshot is evidence looked at in passing — "did this really go through" —
 * and a new browser tab makes that a round trip away from the queue being worked.
 * Escape and a click outside both close it.
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useDismiss(onClose)

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={alt}>
      <button className="lightbox-close" onClick={onClose} aria-label="Закрыть">
        ✕
      </button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-hint">Escape или клик мимо — закрыть</div>
    </div>
  )
}

/**
 * A path shown for copying, not for reading: one click puts it on the clipboard.
 *
 * The paths here are always used the same way — pasted into a terminal — so selecting
 * them by hand is the only step between seeing one and using it. Clipboard access can
 * be refused (it needs a secure context), so the fallback says so instead of silently
 * doing nothing.
 */
export function CopyPath({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(t)
  }, [state])

  const copy = (): void => {
    const done = navigator.clipboard?.writeText(path)
    if (!done) {
      setState('failed')
      return
    }
    void done.then(() => setState('copied')).catch(() => setState('failed'))
  }

  return (
    <button type="button" className="copy-path mono" onClick={copy} title="скопировать путь">
      {path}
      {state !== 'idle' && <span className="dim"> · {state === 'copied' ? 'скопировано' : 'не вышло'}</span>}
    </button>
  )
}
