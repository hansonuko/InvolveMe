import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'InvolveMe Admin',
  description: 'InvolveMe internal ops console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
