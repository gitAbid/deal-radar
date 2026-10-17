import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/nav';

export const metadata: Metadata = {
  title: { default: 'Deal Radar', template: '%s · Deal Radar' },
  description: 'PeraByte AI internal deal monitoring dashboard',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-neutral-50 font-sans text-[13px] text-neutral-900 antialiased">
        <Nav />
        <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
