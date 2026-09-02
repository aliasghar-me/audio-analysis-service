import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

// One family, three weights. Loaded through next/font so it is self-hosted at
// build time — no render-blocking request to a third party at run time.
const sans = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Audio Analysis Service',
  description: 'Upload an MP3 and get its duration, encoding quality and duplicate status.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>{children}</body>
    </html>
  );
}
