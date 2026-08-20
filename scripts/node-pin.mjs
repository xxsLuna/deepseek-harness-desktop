// Whether harness.json's Node pin can still satisfy what upstream asks for.
//
// The chain this closes: `tests/contract/native-tools.spec.ts` asserts Electron's
// bundled Node major equals `harness.json`'s `node`, and that pin is what says
// which Electron this app may run the harness on. Nothing compared the pin
// against upstream's own `engines.node` — so a release that raised its
// requirement past the Electron we ship would stage, package and ship, then fail
// at whatever the newer Node was needed for.
//
// Upstream has left `engines` unset in every version pinned so far, which is
// exactly why the gap went unnoticed: there was nothing to disagree with.
import { satisfies, validRange } from 'semver'

/**
 * Why the pinned Node major cannot serve upstream's requirement, if it cannot.
 * @param engines - upstream's `engines.node`, possibly absent or empty.
 * @param pinnedMajor - `harness.json`'s `node`, a bare major like "24".
 * @returns `{ conflict }` when they disagree, `{ unparseable }` when the range
 * cannot be read, or an empty object when there is nothing to report.
 */
export function nodePinVerdict(engines, pinnedMajor) {
  if (typeof engines !== 'string' || engines.trim() === '') return {}
  const range = engines.trim()
  if (validRange(range) === null) return { unparseable: range }
  // Compared as `<major>.0.0`, the lowest version the pin admits. A range that
  // needs more than the major — `>=24.5.0` against a pin of `24` — is reported
  // as a conflict rather than waved through: the pin cannot promise a minor, so
  // only Electron's actual Node could, and that is asserted separately. Erring
  // toward reporting is the safe direction for a check nothing else covers.
  if (satisfies(`${pinnedMajor}.0.0`, range, { includePrerelease: true })) return {}
  return { conflict: `upstream requires Node ${range}, but harness.json pins ${pinnedMajor}` }
}
