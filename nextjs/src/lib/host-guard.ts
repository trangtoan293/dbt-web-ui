import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * Refuse URLs that point back into this deployment's own network.
 *
 * A model provider's Base URL is typed by the user and then fetched by the
 * server, which makes it the same surface dbt-runner's `app/core/host_guard.py`
 * guards for connection hosts: without a check, `http://169.254.169.254/...`
 * returns instance credentials and `http://postgres:5432` probes the app
 * database, with the response handed back to the browser.
 *
 * Addresses are checked *after* resolution, so a public name that answers with
 * 127.0.0.1 is caught regardless of what it is called.
 *
 * ponytail: resolves for the check, but fetch() resolves again when it
 * connects, so a racing DNS change can still slip past. Pinning the resolved
 * address into the request is the fix if this ever guards untrusted users
 * rather than colleagues.
 */

export class HostNotAllowed extends Error {}

/**
 * On-premise deployments run their gateway on the LAN, so private ranges are a
 * setting rather than a rule. Loopback and link-local never open: loopback is
 * the frontend container itself, and link-local is the metadata service.
 */
function privateHostsAllowed(): boolean {
  return process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS === "true"
}

function ipv4Rules(address: string): string | null {
  const parts = address.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "it is not a usable address"
  }
  const [a, b] = parts
  if (a === 127) return "loopback is this container itself, not your gateway host"
  if (a === 0) return "it is not a usable address"
  if (a === 169 && b === 254) return "link-local and cloud metadata addresses are blocked"
  if (a === 10) return "it is a private address"
  if (a === 172 && b >= 16 && b <= 31) return "it is a private address"
  if (a === 192 && b === 168) return "it is a private address"
  if (a === 100 && b >= 64 && b <= 127) return "it is a carrier-private address"
  return null
}

function ipv6Rules(address: string): string | null {
  const value = address.toLowerCase().split("%")[0]
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return ipv4Rules(mapped[1])
  // WHATWG URL re-serialises an IPv4-mapped literal into hex groups, so
  // ::ffff:169.254.169.254 arrives here as ::ffff:a9fe:a9fe.
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16)
    const low = parseInt(mappedHex[2], 16)
    return ipv4Rules([high >> 8, high & 255, low >> 8, low & 255].join("."))
  }
  if (value === "::1") return "loopback is this container itself, not your gateway host"
  if (value === "::") return "it is not a usable address"
  if (/^fe[89ab]/.test(value)) return "link-local and cloud metadata addresses are blocked"
  if (/^f[cd]/.test(value)) return "it is a private address"
  return null
}

/** Every reason to refuse an address, or null when it is reachable and public. */
function refusalFor(address: string): string | null {
  return isIP(address) === 6 ? ipv6Rules(address) : ipv4Rules(address)
}

async function resolveAll(host: string): Promise<string[]> {
  if (isIP(host)) return [host]
  try {
    const records = await lookup(host, { all: true })
    if (records.length === 0) throw new Error("no address")
    return records.map((record) => record.address)
  } catch {
    throw new HostNotAllowed(`Host “${host}” could not be resolved from this deployment.`)
  }
}

export async function assertUrlHostAllowed(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new HostNotAllowed("Base URL must be a valid http(s) URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HostNotAllowed("Base URL must be a valid http(s) URL")
  }
  // new URL keeps the brackets of an IPv6 literal; the address is what resolves.
  const host = parsed.hostname.replace(/^\[|\]$/g, "")

  for (const address of await resolveAll(host)) {
    const refusal = refusalFor(address)
    if (!refusal) continue
    const isPrivate = refusal.includes("private")
    if (isPrivate && privateHostsAllowed()) continue
    throw new HostNotAllowed(
      isPrivate
        ? `Base URL “${host}” is not allowed: ${refusal}. Set AI_PROVIDER_ALLOW_PRIVATE_HOSTS=true to reach a gateway on this network.`
        : `Base URL “${host}” is not allowed: ${refusal}.`,
    )
  }
}
