// Serbian Cyrillic -> Latin (lowercase; input is lowercased first). Covers the 24 sr-Cyrl profiles.
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "đ", е: "e", ж: "ž", з: "z", и: "i", ј: "j", к: "k", л: "l", љ: "lj", м: "m",
  н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t", ћ: "ć", у: "u", ф: "f", х: "h", ц: "c", ч: "č", џ: "dž", ш: "š",
}

/** For comparing quotes with sources: NFC, lowercase, Cyrillic as Latin, one kind of dash and quote mark, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (c) => CYRILLIC[c] ?? c)
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“-‟]/g, '"')
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
}
