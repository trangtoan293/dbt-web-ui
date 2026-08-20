import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from 'next-auth/react';
import { ClientErrorReporter } from "@/components-v2/observability/ClientErrorReporter";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/branding";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: `${PRODUCT_NAME}: ${PRODUCT_TAGLINE}`,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ClientErrorReporter />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
