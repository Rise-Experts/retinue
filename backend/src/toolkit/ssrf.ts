/**
 * SSRF, closed at the point of connection — REQ-055 (#237), task #238, AC-3.
 *
 * This is the substance of the package. An agent that fetches URLs a model chose is a server-side request
 * forgery primitive unless something stops it, and the naive implementation — check the hostname, then call
 * `fetch` — is defeated three separate ways:
 *
 * 1. **A private or link-local literal.** `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 *    returns cloud credentials in plain text on EC2. `[::ffff:169.254.169.254]` is the same address wearing a
 *    different hat, and so is `0177.0.0.1`.
 * 2. **A public name that resolves to a private address.** `metadata.attacker.example` with an `A` record of
 *    `169.254.169.254` passes every hostname check ever written, because the hostname is genuinely public.
 * 3. **A redirect.** The check ran on the URL that was requested, and the response says to go somewhere else.
 *
 * Each needs its own defence, and each has its own test.
 *
 * ## Why this resolves DNS itself rather than trusting a check-then-fetch
 *
 * Vector 2's obvious fix — resolve the name, look at the addresses, then call `fetch` — leaves a window: the
 * fetch resolves the name a *second* time, and a DNS record with a one-second TTL can answer differently. That
 * is DNS rebinding, it is not theoretical, and a check that a determined caller can lose a race against is a
 * check that reports safety it does not provide.
 *
 * So the resolution and the connection are the same event. `node:https` accepts a `lookup` function, called at
 * connect time with the hostname; this module supplies one that returns **only** an address it has just
 * validated. There is no second resolution to poison. TLS still verifies the certificate against the hostname
 * from the URL, so pinning the address costs nothing in transport security.
 *
 * This is why the package uses `node:https` rather than the shared `createHttpClient`: `fetch` has no way to
 * say "connect to this address". The trade is written down in `check:transport`'s exemption list.
 *
 * ## What is deliberately *not* claimed
 *
 * This closes access to private network space. It does not make fetching arbitrary URLs safe in general — the
 * content that comes back is still untrusted, which is a separate problem handled by the untrusted-content
 * fence rather than here.
 */

import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";

/**
 * How this identifies itself, honestly.
 *
 * A real name and a URL that explains what it is, because the alternative — impersonating a browser — is the
 * bot-detection evasion this package declines to do, and because a site that wants to refuse a crawler should
 * be able to. Several sites answer a *missing* User-Agent with a 429 that is not a rate limit, so sending
 * nothing is not an option either.
 */
export const DEFAULT_USER_AGENT = "RetinueBot/1.0 (+https://retinue.dev/integrations/scrape)";

/** Why an address or host was refused. `null` means it is acceptable. */
export type Refusal = string | null;

const v4Parts = (host: string): number[] | null => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return null;
  const parts = match.slice(1, 5).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
};

/**
 * Whether an IPv4 address is somewhere a fetch must not go.
 *
 * Broader than "the RFC 1918 ranges", because the ranges that matter are the ones that reach something. In
 * particular `100.64/10` (carrier-grade NAT) is where several hosting providers put internal services, and
 * `0.0.0.0/8` is a well-known way of writing "this host" that a naive `127.` check misses entirely.
 */
export const isPrivateV4 = (host: string): boolean => {
  const parts = v4Parts(host);
  if (parts === null) return false;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true; // "this network" — 0.0.0.0 reaches localhost on Linux
  if (a === 10 || a === 127) return true; // private, loopback
  if (a === 169 && b === 254) return true; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // IETF protocol assignments, incl. 192.0.0.192
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved — 224/4 and 240/4
  return false;
};

/**
 * Whether an IPv6 address is somewhere a fetch must not go.
 *
 * The mapped and embedded forms are the interesting part: `::ffff:169.254.169.254` and `::169.254.169.254` are
 * both the metadata address, and `2002:a9fe:a9fe::` is it again inside a 6to4 prefix. A v6 check that does not
 * look inside those is a v4 check with extra steps.
 */
export const isPrivateV6 = (host: string): boolean => {
  const address = host.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  if (address === "" || address === "::" || address === "::1") return true;

  // An embedded IPv4 address — `::ffff:1.2.3.4`, `::1.2.3.4` — is judged as the IPv4 address it contains.
  const embedded = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(address);
  if (embedded?.[1] !== undefined) return isPrivateV4(embedded[1]);

  // The same thing written in hex: `::ffff:a9fe:a9fe`.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hexMapped !== null) {
    const high = Number.parseInt(hexMapped[1] ?? "0", 16);
    const low = Number.parseInt(hexMapped[2] ?? "0", 16);
    return isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  // 6to4: `2002:<v4 in hex>::/48` routes to the embedded IPv4 address.
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(address);
  if (sixToFour !== null) {
    const high = Number.parseInt(sixToFour[1] ?? "0", 16);
    const low = Number.parseInt(sixToFour[2] ?? "0", 16);
    if (isPrivateV4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)) return true;
  }

  const head = address.split(":")[0] ?? "";
  const leading = Number.parseInt(head === "" ? "0" : head, 16);
  if ((leading & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((leading & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((leading & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
};

export const isPrivateAddress = (address: string): boolean =>
  address.includes(":") ? isPrivateV6(address) : isPrivateV4(address);

/** Hostnames that name something internal by convention rather than by address. */
const INTERNAL_NAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  // The metadata service on GCP, Azure and Alibaba respectively. Each resolves to a link-local address, so the
  // address check catches them too — named here so a refusal says *what* was refused.
  "metadata.google.internal",
  "metadata.azure.com",
  "metadata",
]);

/**
 * Refuses a URL on its face, before any resolution.
 *
 * Scheme and shape only. A hostname that merely *looks* fine still has to survive resolution, which is the
 * next function — this one exists so an obviously bad URL costs no DNS query and gives a specific message.
 */
export const refuseUrl = (url: URL): Refusal => {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${url.protocol}// is not a scheme this can fetch. Only http and https are supported — a file:, ftp: or data: URL is refused.`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "") return "That URL has no host.";
  if (INTERNAL_NAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return `${host} names something on the internal network, which this tool does not fetch.`;
  }
  /**
   * An address literal is judged immediately, and a *hostname* is not judged here at all.
   *
   * A hostname cannot be classified without resolving it — that is vector 2 — so the temptation is to apply a
   * heuristic. There isn't a sound one, and a heuristic here would be the check that makes the real check feel
   * redundant.
   */
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    if (isPrivateAddress(host)) {
      return `${host} is a private, loopback or link-local address, which this tool does not fetch.`;
    }
    // A dotted-quad that is not four valid octets is either malformed or an obfuscated form like `0177.0.0.1`
    // or `2130706433`, both of which resolve to loopback in some stacks. Neither is a URL anyone means.
    if (!host.includes(":") && v4Parts(host) === null) {
      return `${host} is not a valid IPv4 address. Octal, hexadecimal and integer forms of an address are refused.`;
    }
  }
  return null;
};

/** Resolves a hostname to addresses. Injectable so the DNS vector can be tested without a DNS server. */
export type Resolve = (hostname: string) => Promise<readonly string[]>;

export const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses.map((entry) => entry.address));
    });
  });

export class BlockedError extends Error {}

/**
 * Resolves a host and refuses it if **any** address is private — then returns the addresses to connect to.
 *
 * *Any*, not *all*. A name with two `A` records, one public and one link-local, is a rebinding attack with the
 * work done up front: connecting to whichever the resolver happened to order first is a coin flip, and a check
 * that passes on a coin flip has not checked anything.
 */
export const resolvePublicly = async (hostname: string, resolve: Resolve): Promise<readonly string[]> => {
  let addresses: readonly string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new BlockedError(`${hostname} could not be resolved.`);
  }
  if (addresses.length === 0) throw new BlockedError(`${hostname} resolved to no addresses.`);
  const blocked = addresses.filter((address) => isPrivateAddress(address));
  if (blocked.length > 0) {
    throw new BlockedError(
      `${hostname} resolves to ${blocked.join(", ")}, which is a private, loopback or link-local address. ` +
        "A public hostname pointing at internal network space is how a fetch tool is turned into a way to read " +
        "cloud metadata, so this is refused rather than followed.",
    );
  }
  return addresses;
};

export type SafeResponse = {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** True when `maxBytes` stopped the read before the body ended. */
  readonly truncated: boolean;
  /** Every URL in the chain, first to last. One entry when there was no redirect. */
  readonly chain: readonly string[];
};

export type SafeFetchOptions = {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly resolve?: Resolve;
  /** Injected by tests, so "no request left the process" can be asserted rather than hoped for. */
  readonly transport?: SafeTransport;
};

/** One request to one already-validated address. Injectable for tests. */
export type SafeTransport = (input: {
  readonly url: URL;
  readonly addresses: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}) => Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>;

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * The real transport: connects to a validated address with `lookup` pinned.
 *
 * The `lookup` callback is what makes this sound. Node calls it at connect time instead of resolving the name,
 * so the address that was checked is the address that is used — there is no second resolution between the
 * check and the socket. The hostname still goes out in SNI and in the `Host` header, so the certificate is
 * verified against the name the caller asked for, not against the IP.
 */
export const nodeTransport: SafeTransport = ({ url, addresses, headers, timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const pinned = addresses[0] as string;
    const family = pinned.includes(":") ? 6 : 4;
    const options: RequestOptions = {
      method: "GET",
      headers,
      // Pinned. Called instead of a DNS lookup, with the address already validated above.
      lookup: (_hostname, _options, callback) => {
        (callback as (error: null, address: string, family: number) => void)(null, pinned, family);
      },
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, options, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        if (truncated) return;
        size += chunk.length;
        if (size > maxBytes) {
          // Bounded *while streaming*, not after: a byte cap enforced on a body already in memory is not a cap.
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          truncated = true;
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      const finish = () => {
        const headerRecord: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headerRecord[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headerRecord[name.toLowerCase()] = value.join(", ");
        }
        resolve({
          status: response.statusCode ?? 0,
          headers: headerRecord,
          body: Buffer.concat(chunks).toString("utf8"),
          truncated,
        });
      };
      response.on("end", finish);
      response.on("close", () => {
        if (truncated) finish();
      });
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`No response within ${timeoutMs}ms.`));
    });
    request.on("error", reject);
    request.end();
  });

/**
 * Fetches a URL with every vector closed, following redirects **by re-running the whole check on each hop**.
 *
 * The shared `createHttpClient` refuses redirects outright, which is the right answer for a vendor API and the
 * wrong one here: a great many real pages are one redirect away from their canonical URL, and a scraper that
 * cannot follow `http → https` or `example.com → www.example.com` is a scraper that fails on ordinary input.
 *
 * So redirects are followed, and the price is that each hop is a fresh, untrusted URL. It gets `refuseUrl` and
 * `resolvePublicly` exactly as the first one did. A chain that starts public and ends at `169.254.169.254` is
 * refused at the hop that turns private, which is the only place it can be caught.
 */
export const safeFetch = async (target: string, options: SafeFetchOptions = {}): Promise<SafeResponse> => {
  const resolve = options.resolve ?? systemResolve;
  const transport = options.transport ?? nodeTransport;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const chain: string[] = [];
  let current: URL;
  try {
    current = new URL(target);
  } catch {
    throw new BlockedError(`"${target}" is not a URL.`);
  }

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const refusal = refuseUrl(current);
    if (refusal !== null) throw new BlockedError(refusal);
    const addresses = await resolvePublicly(current.hostname, resolve);
    chain.push(current.toString());

    const response = await transport({
      url: current,
      addresses,
      headers: {
        // A real, honest identifier. Several sites answer a missing User-Agent with a 429 that is not a rate
        // limit, and misrepresenting the client is the bot-detection evasion this package declines to do.
        "user-agent": options.headers?.["user-agent"] ?? DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        ...options.headers,
      },
      timeoutMs,
      maxBytes,
    });

    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined && location !== "") {
      if (hop === maxRedirects) {
        throw new BlockedError(`That URL redirected more than ${maxRedirects} times, so the chain was abandoned.`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new BlockedError(`That URL redirected to "${location}", which is not a URL.`);
      }
      current = next;
      continue;
    }

    return {
      url: current.toString(),
      status: response.status,
      headers: response.headers,
      body: response.body,
      truncated: response.truncated,
      chain,
    };
  }
  throw new BlockedError(`That URL redirected more than ${maxRedirects} times, so the chain was abandoned.`);
};
