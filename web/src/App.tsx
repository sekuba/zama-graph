import { useEffect, useRef, useState } from 'react'
import type { Status } from '../../src/graph/types'
import { About } from './About'
import { AddressPage } from './AddressPage'
import { api, useApi } from './api'
import { HandlePage } from './HandlePage'
import { Live } from './Live'
import { Readers } from './Readers'
import { home, parse } from './route'
import { TxPage } from './TxPage'
import { Loading } from './ui'

/**
 * One page per thing one can search for, chosen by the URL hash: the live
 * view, an address, a transaction (with its unwraps), a ciphertext handle;
 * and who can read, and how it works.
 */
export function App() {
  const [route, setRoute] = useState(() => parse(location.hash))
  const current = useRef(route)
  const [input, setInput] = useState('')
  const { data: status, error: offline } = useApi(api.status, undefined)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onHash = () => {
      const next = parse(location.hash)
      // from one number of the live view to another: stay where the reader is
      if (next.page !== 'live' || current.current.page !== 'live') {
        window.scrollTo(0, 0)
      }
      current.current = next
      setRoute(next)
      setError(undefined)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // anything else typed in: an address, a tx or a handle the index knows
  useEffect(() => {
    if (route.page !== 'search') return
    let cancelled = false
    api
      .search(route.value)
      .then((r) => {
        if (cancelled) return
        if (r.type === 'address') location.hash = r.value
        else if (r.type === 'tx') location.hash = `tx/${r.value}`
        else if (r.type === 'handle') location.hash = `handle/${r.value}`
        else setError(`Nothing in the index matches ${route.value}.`)
      })
      .catch((e: unknown) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [route])

  const nav = (href: string, text: string, on: boolean) => (
    <a
      href={href}
      className={on ? 'text-ink' : undefined}
      onClick={href === './' ? home : undefined}
    >
      {text}
    </a>
  )

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3 p-2 sm:p-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="whitespace-nowrap font-semibold">
          <a href="./" onClick={home}>
            <span className="logo" />
            zama explorer
          </a>
        </h1>
        <form
          className="order-last w-full sm:order-none sm:w-auto sm:flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            const q = input.trim()
            if (q) location.hash = q
          }}
        >
          <input
            className="search mono"
            placeholder="Address, transaction or handle"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
          />
        </form>
        {status && <SyncStatus status={status} />}
        <nav className="flex gap-3 whitespace-nowrap text-xs text-muted">
          {nav('./', 'live', route.page === 'live')}
          {nav('#readers', 'readers', route.page === 'readers')}
          {nav('#about', 'method', route.page === 'about')}
          <a
            href="https://l2beat.com/privacy/projects/zama-cw"
            target="_blank"
            rel="noreferrer"
          >
            L2BEAT
          </a>
        </nav>
      </header>

      {offline && (
        <div className="text-negative">
          The indexer is offline right now. Try again in a few minutes.
        </div>
      )}
      {error && <div className="text-ink-2">{error}</div>}

      {route.page === 'live' && !offline && <Live filter={route.filter} />}
      {route.page === 'address' && <AddressPage address={route.value} />}
      {route.page === 'tx' && <TxPage hash={route.value} />}
      {route.page === 'unwrap' && <ToTx handle={route.value} />}
      {route.page === 'handle' && <HandlePage handle={route.value} />}
      {route.page === 'readers' && <Readers />}
      {route.page === 'about' && <About status={status} />}

      <footer className="mt-6 text-xs text-muted">
        Derived from Ethereum and the Zama Gateway only.
      </footer>
    </div>
  )
}

/** An unwrap is shown on the page of the transaction that requested it */
function ToTx({ handle }: { handle: string }) {
  const { data, error } = useApi(api.unwrap, handle)
  useEffect(() => {
    if (data) location.replace(`#tx/${data.tx}`)
  }, [data])
  return <Loading error={error} />
}

function SyncStatus({ status }: { status: Status }) {
  return (
    <div
      className="hidden whitespace-nowrap text-xs text-muted lg:block"
      title="Last indexed Ethereum and Zama Gateway blocks"
    >
      eth {status.ethBlock?.toLocaleString('en-US') ?? '–'} · gateway{' '}
      {status.gatewayBlock?.toLocaleString('en-US') ?? '–'}
    </div>
  )
}
