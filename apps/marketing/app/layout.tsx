import type { Metadata } from 'next';
import { ThemeProvider } from 'next-themes';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'InvolveMe | Pay-per-message chat',
    template: '%s | InvolveMe',
  },
  description:
    "InvolveMe is a chat app where messaging is pay-per-message: your time, and everyone else's, has real value.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
          <Nav />
          <main className="flex-1">{children}</main>
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
