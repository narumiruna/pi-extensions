const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MAX_TERMS = 32;
const MAX_TERM_LENGTH = 64;

export function searchTerms(value: string): string[] {
  const normalized = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_./\\-]+/g, " ")
    .toLocaleLowerCase("en-US");
  const terms: string[] = [];
  const seen = new Set<string>();
  const addTerm = (term: string) => {
    if (!term || seen.has(term) || terms.length >= MAX_TERMS) return;
    seen.add(term);
    terms.push(term);
  };
  for (const match of normalized.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (!word) continue;
    if (containsCjk(word)) {
      const characters = [...word];
      if (characters.length === 1) addTerm(word);
      else {
        for (let index = 0; index < characters.length - 1 && terms.length < MAX_TERMS; index += 1) {
          addTerm(`${characters[index]}${characters[index + 1]}`);
        }
      }
    } else {
      addTerm(word.slice(0, MAX_TERM_LENGTH));
    }
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

export function searchableText(value: string): string {
  const terms = searchTerms(value);
  return `${value.normalize("NFKC")} ${terms.join(" ")}`.trim();
}

export function ftsExpression(value: string): string | undefined {
  const terms = searchTerms(value);
  if (terms.length === 0) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function containsCjk(value: string): boolean {
  return [...value].some((character) => CJK_PATTERN.test(character));
}
