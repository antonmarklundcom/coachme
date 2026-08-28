import type { Metadata, Viewport } from 'next';
import { Archivo, JetBrains_Mono, Source_Sans_3 } from 'next/font/google';
import './globals.css';

const archivo = Archivo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-archivo' });
const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600'],
  style: ['normal', 'italic'],
  variable: '--font-source-sans',
});
const jetBrainsMono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-jetbrains-mono' });

export const metadata: Metadata = {
  title: 'coachme',
  description: 'Portfolio focus coach — one prepped action a day.',
  // The PWA half: Android reads the manifest, iOS reads the apple-touch-icon
  // and the two apple-mobile-web-app tags, which Next emits from `appleWebApp`.
  manifest: '/manifest.json',
  applicationName: 'coachme',
  appleWebApp: { capable: true, title: 'coachme', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
};

// Opened on a phone, every morning.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f6f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1117' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${sourceSans.variable} ${jetBrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
