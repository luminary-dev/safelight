import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dir, locale } from "@/i18n/config";
import "./globals.css";

const body = Outfit({ variable: "--font-body", subsets: ["latin"], weight: "variable" });
const mono = JetBrains_Mono({ variable: "--font-mono-face", subsets: ["latin"], weight: "variable" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    // The wordmark is a product name, not a translatable string.
    title: "Safelight",
    description: t("description"),
    icons: { icon: "/safelight-mark.svg" },
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang={locale} dir={dir} className={`${body.variable} ${mono.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before first paint so there is no flash. Light is the default. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q||(localStorage.getItem("safelight.theme")||localStorage.getItem("studio.theme"));document.documentElement.classList.toggle("dark",t==="dark");}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full">
        {/* Locale and messages come from src/i18n/request.ts (fixed "en" for now). */}
        <NextIntlClientProvider>
          <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
