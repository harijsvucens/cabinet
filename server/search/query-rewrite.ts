const QUESTION_PREFIXES = [
  "who is",
  "what is",
  "what are",
  "what was",
  "what did",
  "what does",
  "what do",
  "where is",
  "where are",
  "where was",
  "where did",
  "when is",
  "when was",
  "when did",
  "how is",
  "how was",
  "how did",
  "how do",
  "how to",
  "why is",
  "why was",
  "why did",
  "why do",
  "which is",
  "tell me about",
  "show me",
  "find",
];

const TRAILING_FRAGMENTS = [
  "to her",
  "to him",
  "to them",
  "to it",
  "about it",
  "about that",
  "about this",
  "for me",
  "for us",
  "for them",
  "in our",
  "in the",
  "in our kb",
  "in our knowledge base",
  "in the knowledge base",
  "in the docs",
  "in the documentation",
];

const TYPO_MAP: Record<string, string> = {
  kopenhagen: "copenhagen",
  exibishon: "exhibition",
  exibition: "exhibition",
  exibhition: "exhibition",
  exebition: "exhibition",
  koncrete: "concrete",
  conkreet: "concrete",
  conkret: "concrete",
  skulpture: "sculpture",
  skulptur: "sculpture",
  architechure: "architecture",
  architechture: "architecture",
  desing: "design",
  desgin: "design",
  buidling: "building",
  bilding: "building",
  latvian: "latvia",
  denmork: "denmark",
  denmarkk: "denmark",
  renate: "renate",
  renāte: "renate",
  lagzdina: "lagzdina",
  lagzdiņa: "lagzdina",
  villa: "villa",
  vila: "villa",
  kuldiga: "kuldiga",
  kuldīga: "kuldiga",
  aizpute: "aizpute",
};

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function cleanQuery(raw: string): string {
  let q = stripDiacritics(raw.trim());

  q = q.replace(/[?!.,;:]+$/g, "").trim();

  const lower = q.toLowerCase();
  for (const prefix of QUESTION_PREFIXES) {
    if (lower.startsWith(prefix + " ")) {
      q = q.slice(prefix.length).trim();
      break;
    }
  }

  const lowerAfter = q.toLowerCase();
  for (const frag of TRAILING_FRAGMENTS) {
    if (lowerAfter.endsWith(" " + frag)) {
      q = q.slice(0, q.length - frag.length).trim();
      break;
    }
  }

  q = q.replace(/\s+and\s+what\s+(did|does|is|was)\s+(we|they|i|you|he|she)\s+\w+(\s+to\s+\w+)?/gi, "").trim();

  q = q.replace(/\s+/g, " ").trim();

  return q;
}

export function rewriteQuery(raw: string): string | null {
  const cleaned = cleanQuery(raw);
  if (!cleaned) return null;

  const words = cleaned.toLowerCase().split(/\s+/);
  let changed = false;

  const rewritten = words.map((word) => {
    const correction = TYPO_MAP[word];
    if (correction && correction !== word) {
      changed = true;
      return correction;
    }
    return word;
  });

  if (!changed) {
    const stripped = stripDiacritics(raw.toLowerCase().trim());
    if (stripped !== cleaned.toLowerCase()) {
      return cleaned;
    }
    if (cleaned !== raw.trim()) {
      return cleaned;
    }
    return null;
  }

  return rewritten.join(" ");
}
