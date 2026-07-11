import type { Category } from "./types.js";

export interface HeuristicContext {
  inCodeProject: boolean;
}

const CODE_VERBS =
  /\b(fix|implement|refactor|debug|rewrite|write|add|create|build|install|configure|deploy|migrate|optimi[sz]e|rename|remove|update)\b/i;
const CODE_VERBS_TR =
  /(düzelt|yeniden yaz|ekle|oluştur|kur|geliştir|uygula|değiştir|kaldır|güncelle|derle|düzenle)/i;
const CODE_ARTIFACTS =
  /(\.[a-z]{1,4}\b|\bfunction\b|\bclass\b|\bbug\b|\berror\b|\bexception\b|\bapi\b|\bendpoint\b|\bdatabase\b|\bcomponent\b|\brepo\b|\bcommit\b|```|\bstack trace\b|\bhata\b|\bfonksiyon\b|\bveritabanı\b|\bkod\b)/i;
const ERROR_TOKENS = /\w+(error|exception)\b/i;

const MAX_SIMPLE_QA_WORDS = 12;

export function heuristicCategory(prompt: string, ctx: HeuristicContext): Category | null {
  const text = prompt.trim();
  if (!text) return null;

  const verb = CODE_VERBS.test(text) || CODE_VERBS_TR.test(text);
  const artifact = CODE_ARTIFACTS.test(text) || ERROR_TOKENS.test(text);

  if (verb && (artifact || ctx.inCodeProject)) return "code";

  const wordCount = text.split(/\s+/).length;
  if (/\?\s*$/.test(text) && wordCount <= MAX_SIMPLE_QA_WORDS && !verb && !artifact) {
    return "simple-qa";
  }

  return null;
}
