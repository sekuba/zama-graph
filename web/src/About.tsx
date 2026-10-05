import type { ReactNode } from 'react'
import type { Status } from '../../src/graph/types'
import { Section } from './ui'

const REPO = 'https://github.com/sekuba/zama-graph'

function Points({ children }: { children: ReactNode }) {
  return <ul className="lead grid list-disc gap-1 pl-4 text-sm">{children}</ul>
}

function Code({ children }: { children: ReactNode }) {
  return <code className="mono text-xs">{children}</code>
}

/** How the numbers are made, and what they rest on */
export function About({ status }: { status: Status | undefined }) {
  const b = status?.bounds
  return (
    <>
      <Section title="Hidden">
        <Points>
          <li>Encrypted: balances and transfer amounts (ERC-7984 handles).</li>
          <li>
            Public: sender, recipient and time of every transfer; wrap amounts;
            finalized unwrap amounts.
          </li>
          <li>
            Every FHE operation is an <Code>FHEVMExecutor</Code> event, so every
            encrypted amount is a public formula over constants, inputs and
            earlier handles.
          </li>
          <li>
            A transfer never fails for lack of funds: if the sender asks for
            more than it holds, the contract sends 0 instead, because failing
            would reveal the balance. So the amount asked for says nothing on
            its own, but what actually moved is never more than the sender held.
          </li>
        </Points>
      </Section>
      <Section title="Amounts">
        <Points>
          <li>
            Facts: published values (wraps, finalized unwraps, KMS decryptions
            on the Gateway, disclosures).
          </li>
          <li>
            Intervals propagate over every operation, forward and backward,
            respecting 64-bit wrap-around.
          </li>
          <li>
            Extra rules: <Code>kept + sent = balance</Code> per transfer; a
            branch is refined by its condition; <Code>x − x = 0</Code>; no
            balance exceeds supply; a batch unwraps exactly its total; a pool
            that keeps an account per member, and the vault router within a
            transaction it starts empty, return no more than was paid in.
          </li>
          <li>
            Each token’s whole history as one network flow: every balance is
            what came in minus what went out, never negative. Its largest and
            smallest possible value bounds each amount and balance, solved
            exactly; each bound it tightens comes with the balances and
            transfers that pin it, checked to add up.
          </li>
          <li>
            Sound: a known exact amount is the only one the data allows.{' '}
            {b &&
              `${b.ops.toLocaleString('en-US')} operations, ${b.contradictions} contradictions.`}{' '}
            16 of 16 pending unwraps with a known exact amount matched the KMS
            (7 of 13 signatures).
          </li>
        </Points>
      </Section>
      <Section title="Links">
        <Points>
          <li>
            Each unwrap is walked back through every transfer that can have
            funded it, to the wraps.
          </li>
          <li>Provably zero transfers and empty balances cut the walk.</li>
          <li>
            Pools are not walked, except auction wallets and vault batchers,
            which only return a member its own funds.
          </li>
          <li>
            A depositor's share is at least what all other sources could not
            cover. A share of 100% is a link.
          </li>
        </Points>
      </Section>
      <Section title="Data">
        <Points>
          <li>
            Ethereum: registry wrappers, ERC-20 deposits, executor operations,
            ACL grants and delegations.
          </li>
          <li>
            Zama Gateway (chain 261131): public decryptions with KMS signatures
            checked against Ethereum, user decryption requests.
          </li>
        </Points>
      </Section>
      <Section title="Limits">
        <Points>
          <li>
            Intervals forget how amounts relate: through circular flows, bounds
            are sound but loose.
          </li>
          <li>No guesses, no identities beyond public labels and ENS names.</li>
          <li>The KMS operators can read everything; nothing here shows it.</li>
          <li>
            <a href={REPO} className="underline">
              Source
            </a>{' '}
            ·{' '}
            <a
              href="https://l2beat.com/privacy/projects/zama-cw"
              className="underline"
            >
              L2BEAT analysis
            </a>
          </li>
        </Points>
      </Section>
    </>
  )
}
