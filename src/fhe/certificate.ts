import type { Cut } from './flow'

type Rational = [bigint, bigint]
function parse(s: string): Rational {
  if (!/^-?\d+(\/\d+)?$/.test(s)) throw new Error('Invalid rational')
  const [n, d = '1'] = s.split('/')
  if (BigInt(d) === 0n) throw new Error('Zero denominator')
  return [BigInt(n as string), BigInt(d)]
}
function add([a, b]: Rational, [c, d]: Rational): Rational {
  return [a * d + c * b, b * d]
}

/** Check the saved arithmetic, including the integer rounding of an LP bound. */
export function validCut(c: Cut, bound: string): boolean {
  try {
    const sum = (handles: number[], values?: string[], weights?: string[]) => {
      if (!values || values.length !== handles.length)
        throw new Error('Missing snapshot')
      return values.reduce<Rational>(
        (total, value, i) => {
          const [n, d] = parse(weights?.[i] ?? '1')
          return add(total, [BigInt(value) * n, d])
        },
        [0n, 1n],
      )
    }
    const plus = add(
      sum(c.plus, c.plusValues, c.plusWeights),
      parse(c.morePlus.total),
    )
    const minus = add(
      sum(c.minus, c.minusValues, c.minusWeights),
      parse(c.moreMinus.total),
    )
    const [n, d] = add(plus, [-minus[0], minus[1]])
    const floor = n / d - (n < 0n && n % d !== 0n ? 1n : 0n)
    const ceil = floor + (n % d !== 0n ? 1n : 0n)
    return (
      (c.rounding === 'up'
        ? ceil
        : c.rounding === 'down'
          ? floor
          : n % d === 0n
            ? n / d
            : undefined) === BigInt(bound)
    )
  } catch {
    return false
  }
}
