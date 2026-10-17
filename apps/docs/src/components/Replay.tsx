/** @jsxImportSource preact */
// A recording of the real CLI, played back with its colors and (slowed a little) its timing. It is the same output the
// terminal on the Test page produces, captured by `docs-demo capture`.

import { useEffect, useRef, useState } from 'preact/hooks'
import { ansiToHtml } from '../lib/ansi'

export interface Capture {
  name: string
  command: string
  exit: number
  chunks: { t: number; data: string }[]
}

/** Recordings are over in a blink; each piece of output waits at least this long so a reader can follow. */
const MIN_GAP_MS = 70

export default function Replay({ capture, title }: { capture: Capture; title?: string }) {
  const [shown, setShown] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timers = useRef<number[]>([])
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const seen = useRef<HTMLDivElement>(null)

  const stop = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }
  function play() {
    stop()
    setShown(0)
    if (reduced()) {
      setShown(capture.chunks.length)
      return
    }
    setPlaying(true)
    let at = 0
    let prev = 0
    capture.chunks.forEach((c, i) => {
      at += Math.max(MIN_GAP_MS, c.t - prev)
      prev = c.t
      timers.current.push(
        window.setTimeout(() => {
          setShown(i + 1)
          if (i === capture.chunks.length - 1) setPlaying(false)
        }, at),
      )
    })
  }

  // plays once when it is on screen
  useEffect(() => {
    const el = seen.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          play()
        }
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      stop()
    }
  }, [])

  const text = shown
    ? capture.chunks
        .slice(0, shown)
        .map((c) => c.data)
        .join('')
    : ''
  const done = shown >= capture.chunks.length
  // the box is as tall as the whole recording from the start, so nothing below it moves while it plays
  const lines = `${capture.command}\n${capture.chunks.map((c) => c.data).join('')}\nexit`.split(
    '\n',
  ).length
  const height = Math.min(lines, 18) * 20.2 + 28
  return (
    <section class="term" ref={seen} aria-label={`Recorded output of ${capture.command}`}>
      <div class="term-bar">
        <span class="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <code class="term-cmd">{title ?? capture.command}</code>
        <span class="grow" />
        <button type="button" class="chip action" disabled={playing} onClick={play}>
          Replay
        </button>
      </div>
      <pre
        class="term-out"
        style={{ height: `${Math.round(height)}px` }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region has to be reachable by keyboard
        tabIndex={0}
        dangerouslySetInnerHTML={{
          __html: ansiToHtml(
            `\u001b[2m$ ${capture.command}\u001b[22m\n${text}${done ? `\n\u001b[2mexit ${capture.exit}\u001b[22m\n` : ''}`,
          ),
        }}
      />
    </section>
  )
}
