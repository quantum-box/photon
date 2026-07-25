/**
 * UUID v7 identifiers.
 *
 * v7 is time-ordered, so ids sort by creation and index well. More importantly
 * for a local-first engine, they are collision-free without a server: the
 * client can name a record before it has ever talked to one, which removes the
 * whole temp-id → server-id swap dance and lets a freshly created record be
 * navigated to immediately, offline.
 *
 * The previous scheme derived ids from `max(existing) + 1`, which produces
 * guaranteed duplicates the moment two clients create records offline.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const crypto = globalThis.crypto
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes)
    return bytes
  }
  // Deterministic environments (SSR shims, restricted workers) still need ids.
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

/**
 * Generate a UUID v7.
 *
 * @param nowMs injectable clock, so tests can produce stable ordering
 */
export function uuidV7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16)
  const timestamp = Math.max(0, Math.floor(nowMs))

  bytes[0] = (timestamp / 2 ** 40) & 0xff
  bytes[1] = (timestamp / 2 ** 32) & 0xff
  bytes[2] = (timestamp / 2 ** 24) & 0xff
  bytes[3] = (timestamp / 2 ** 16) & 0xff
  bytes[4] = (timestamp / 2 ** 8) & 0xff
  bytes[5] = timestamp & 0xff

  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant

  const hex = Array.from(bytes, (byte) => HEX[byte]!)
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  )
}

/** `prefix_<uuidv7>`, or a bare uuid when no prefix is given. */
export function newId(prefix?: string, nowMs?: number): string {
  const id = uuidV7(nowMs)
  return prefix ? `${prefix}_${id}` : id
}
