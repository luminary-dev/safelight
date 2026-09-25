import type { Metadata } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const body = Outfit({ variable: "--font-body", subsets: ["latin"], weight: "variable" });
const mono = JetBrains_Mono({ variable: "--font-mono-face", subsets: ["latin"], weight: "variable" });

export const metadata: Metadata = {
  title: "Safelight",
  description: "Your private darkroom: image generation and chat with your own models.",
  icons: { icon: "/h2o-cube.svg" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${body.variable} ${mono.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* Applies the saved theme before first paint so there is no flash. Light is the default. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q||localStorage.getItem("studio.theme");document.documentElement.classList.toggle("dark",t==="dark");}catch(e){}})();`,
          }}
        />
      </head>
      <body className="min-h-full">
        <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
