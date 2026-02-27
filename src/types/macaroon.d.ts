/**
 * Ambient type declarations for the untyped `macaroon` npm package.
 * Based on the package's README and source (v3.0.4).
 */
declare module 'macaroon' {
  export interface Caveat {
    /** Caveat identifier bytes (first-party caveats only have this). */
    identifier: Uint8Array
    /** Verification id bytes (third-party caveats only). */
    vid?: Uint8Array
    /** Location hint (third-party caveats only). */
    location?: string
  }

  export interface MacaroonParams {
    identifier: string | Uint8Array
    location?: string
    rootKey: string | Uint8Array
    version?: 1 | 2
  }

  export interface Macaroon {
    readonly location: string
    readonly identifier: Uint8Array
    readonly signature: Uint8Array
    readonly caveats: Caveat[]

    addFirstPartyCaveat(caveatId: string | Uint8Array): void
    addThirdPartyCaveat(rootKeyBytes: Uint8Array, caveatIdBytes: string | Uint8Array, locationStr?: string): void
    bindToRoot(rootSig: Uint8Array): void
    clone(): Macaroon
    verify(rootKeyBytes: Uint8Array, check: (condition: string) => string | null, discharges: Macaroon[]): void
    exportJSON(): object
    exportBinary(): Uint8Array
  }

  export function newMacaroon(params: MacaroonParams): Macaroon
  export function importMacaroon(obj: string | Uint8Array | object): Macaroon
  export function importMacaroons(obj: string | Uint8Array | object | object[]): Macaroon[]
  export function base64ToBytes(s: string): Uint8Array
  export function bytesToBase64(bytes: Uint8Array): string
}
