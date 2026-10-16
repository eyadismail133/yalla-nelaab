/**
 * Room codes get read aloud across a room and typed on phone keyboards, so the alphabet
 * excludes every pair people confuse: O/0, I/1/L, S/5, B/8, Z/2.
 */
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
export const CODE_LENGTH = 5;

export function generateCode(rng: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return code;
}

/**
 * Accepts what a player actually types: lowercase, stray spaces, dashes pasted from a link.
 *
 * No lookalike substitution here on purpose — since the alphabet never emits O/0/I/1/L, a
 * typed "O" is simply a mistake with no correct target, and guessing one would turn a typo
 * into a join attempt on somebody else's room.
 */
export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-_]/g, '');
}
