import { getRequestConfig } from "next-intl/server";
import { locale } from "./config";

/**
 * next-intl request configuration, wired through createNextIntlPlugin in
 * next.config.ts. No locale routing: every request resolves to the fixed
 * locale from src/i18n/config.ts (see the TODO there for the settings-backed
 * locale switch).
 */
export default getRequestConfig(async () => ({
  locale,
  messages: (await import(`./${locale}.json`)).default,
}));
