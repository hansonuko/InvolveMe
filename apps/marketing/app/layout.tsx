import type { Metadata } from 'next';
import { ThemeProvider } from 'next-themes';
import { Footer } from '@/components/Footer';
import { InstallNudgeBanner } from '@/components/InstallNudgeBanner';
import { Nav } from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'InvolveMe | Earn per message',
    template: '%s | InvolveMe',
  },
  description:
    'InvolveMe is a chat app where you get paid every time someone needs your time: reply to a message and earn, with pay-per-minute calls coming next.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <ThemeProvider attribute="data-theme" defaultTheme="system" enableSystem>
          <Nav />
          <main className="flex-1">{children}</main>
          <Footer />
          <InstallNudgeBanner />
        </ThemeProvider>
      </body>
    </html>
  );
}
