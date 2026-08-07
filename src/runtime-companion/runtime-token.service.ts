import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Minting and verification for machine tokens and pairing codes.
 *
 * Both are stored as SHA-256 hashes and never in plaintext, so a database dump does not hand over
 * the ability to impersonate a workstation. Hashes are also what make lookup cheap: the daemon
 * polls for work every 5 seconds per adapter, so authentication has to be a single indexed read.
 */
@Injectable()
export class RuntimeTokenService {
  /** Ambiguous characters (0/O, 1/I/L) are excluded — this code gets read off a screen and retyped. */
  private static readonly CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  /** Opaque bearer token stored in the machine's OS credential manager. */
  mintMachineToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * A pairing code in `ABCD-EFGH` form.
   *
   * Grouped with a dash purely because humans transcribe chunked strings more reliably; the dash
   * carries no meaning and is stripped again by `normalizeCode` before hashing.
   */
  mintPairingCode(): string {
    const alphabet = RuntimeTokenService.CODE_ALPHABET;
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
  }

  /**
   * Collapse a code to its canonical form before hashing.
   *
   * The CLI forwards whatever the user typed, verbatim — lowercase, missing dash, stray spaces and
   * all. Normalizing on both sides means those variations still match instead of reading as a
   * wrong code, which would be an unexplainable failure from the user's side.
   */
  normalizeCode(code: string): string {
    return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  /** Constant-time compare, for the rare paths that compare hashes in application code. */
  matches(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
