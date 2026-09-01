import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Audio Analysis Service',
  description: 'Upload an MP3 and get its duration, encoding quality and duplicate status.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
