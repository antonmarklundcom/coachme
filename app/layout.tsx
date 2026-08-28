import type { Metadata, Viewport } from 'next';
import './globals.css';

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
    { media: '(prefers-color-scheme: light)', color: '#fbfaf8' },
    { media: '(prefers-color-scheme: dark)', color: '#14161a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
