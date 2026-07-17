import type { Category } from "./types.js";

export interface HeuristicContext {
  inCodeProject: boolean;
}

// Verbs that are near-unambiguous coding requests: strong enough to stand
// alone inside a code project.
const STRONG_CODE_VERBS =
  /\b(implement(?:s|ed|ing)?|refactor(?:s|ed|ing)?|debug(?:s|ged|ging)?|deploy(?:s|ed|ing)?|migrat(?:e|es|ed|ing)|compil(?:e|es|ed|ing)|optimi[sz](?:e|es|ed|ing))\b/i;
// Everyday verbs that only signal code next to a code artifact — "write a
// poem" or "add milk to the list" must not read as code tasks.
const WEAK_CODE_VERBS =
  /\b(fix(?:es|ed|ing)?|rewrit(?:e|es|ing|ten)|writ(?:e|es|ing|ten)|add(?:s|ed|ing)?|creat(?:e|es|ed|ing)|build(?:s|ing|t)?|install(?:s|ed|ing)?|configur(?:e|es|ed|ing)|renam(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|updat(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|merg(?:e|es|ed|ing)|revert(?:s|ed|ing)?|generat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing))\b/i;

// Turkish is agglutinative and JS \b is ASCII-only, so anchor each stem with a
// Unicode left boundary and let suffixes follow freely ("düzelt" → "düzeltir").
const STRONG_CODE_VERBS_TR = /(?<![\p{L}])(hata ayıkla|kodla|programla|derle)/iu;
const WEAK_CODE_VERBS_TR =
  /(?<![\p{L}])(düzelt|yeniden yaz|yaz|yap|ekle|oluştur|kur|geliştir|uygula|değiştir|kaldır|güncelle|düzenle|çalıştır|sil)/iu;

// A real filename shape — a bare `\.[a-z]{1,4}` would also match "e.g.",
// "example.com", and "5 p.m.".
const FILE_EXTENSION =
  /\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|cc|hpp|css|scss|html|vue|svelte|sql|sh|bash|ps1|yml|yaml|toml|json|md|lock|env|txt)\b/i;
const CODE_ARTIFACTS =
  /(\bfunction\b|\bbug\b|\berror\b|\bexception\b|\bapi\b|\bendpoint\b|\bdatabase\b|\bcomponent\b|\brepo(?:sitory)?\b|\bcommit\b|```|\bstack trace\b|\bcode\b|\bscript\b|\bregex\b|\bpull request\b|\bunit tests?\b|\bpython\b|\btypescript\b|\bjavascript\b)/i;
const CODE_ARTIFACTS_TR = /(?<![\p{L}])(hata|fonksiyon|veritaban|kod|betik)/iu;
// CamelCase runtime errors only — case-sensitive so "terror" and "Terror"
// don't count as code evidence.
const ERROR_TOKENS = /\b[A-Z]\w*(?:Error|Exception)\b/;

const MAX_SIMPLE_QA_WORDS = 12;

function hasCodeArtifact(text: string): boolean {
  return (
    FILE_EXTENSION.test(text) ||
    CODE_ARTIFACTS.test(text) ||
    CODE_ARTIFACTS_TR.test(text) ||
    ERROR_TOKENS.test(text)
  );
}

export function heuristicCategory(prompt: string, ctx: HeuristicContext): Category | null {
  const text = prompt.trim();
  if (!text) return null;

  const strongVerb = STRONG_CODE_VERBS.test(text) || STRONG_CODE_VERBS_TR.test(text);
  const verb = strongVerb || WEAK_CODE_VERBS.test(text) || WEAK_CODE_VERBS_TR.test(text);
  const artifact = hasCodeArtifact(text);

  // An artifact plus any code verb is decisive. A strong verb is decisive on
  // its own inside a code project — but a generic verb alone proves nothing,
  // even in a repo, or every everyday request becomes a "code" task.
  if (verb && artifact) return "code";
  if (strongVerb && ctx.inCodeProject) return "code";

  const wordCount = text.split(/\s+/).length;
  if (/\?\s*$/.test(text) && wordCount <= MAX_SIMPLE_QA_WORDS && !verb && !artifact) {
    return "simple-qa";
  }

  return null;
}

// Markers of work that spans many files or a whole system.
const HEAVY_HINTS =
  /\b(redesign|rearchitect|architecture|migrat(?:e|es|ed|ing|ion)|overhaul|entire|whole|across|production|end.to.end|integrat(?:e|es|ed|ing|ion)|from scratch)\b/i;
const HEAVY_HINTS_TR =
  /(?<![\p{L}])(baştan|sıfırdan|tüm|bütün|mimari|yeniden tasarla|uçtan uca|entegrasyon)/iu;
// Markers of a small, contained edit.
const LIGHT_HINTS =
  /\b(typo|renam(?:e|es|ed|ing)|one.?liner?|single line|quick|small|tiny|minor|trivial|comment|bump|readme)\b/i;
const LIGHT_HINTS_TR = /(?<![\p{L}])(yazım hatası|ufak|küçük|basit|tek satır|hızlıca)/iu;

/**
 * Coarse complexity estimate for when the classifier is unavailable, so the
 * Claude Code route can still pick a model/effort tier per task. Deliberately
 * conservative: unknown means the middle tier, never the top or bottom one.
 */
export function estimateComplexity(prompt: string): number {
  const text = prompt.trim();
  if (!text) return 0.5;

  const wordCount = text.split(/\s+/).length;
  if (HEAVY_HINTS.test(text) || HEAVY_HINTS_TR.test(text) || wordCount > 40) return 0.8;
  if ((LIGHT_HINTS.test(text) || LIGHT_HINTS_TR.test(text)) && wordCount <= 20) return 0.2;
  return 0.5;
}
