import Link from 'next/link';

const LINKS = [
  { href: '/', label: 'Deals' },
  { href: '/review', label: 'Review' },
  { href: '/sources', label: 'Sources' },
  { href: '/targets', label: 'Targets' },
  { href: '/runs', label: 'Runs' },
] as const;

export function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-neutral-200 bg-white">
      <div className="mx-auto flex h-11 w-full max-w-[1500px] items-center gap-5 px-4">
        <Link href="/" className="text-sm font-semibold tracking-tight text-neutral-900">
          Deal Radar
        </Link>
        <nav className="flex items-center gap-1 text-[13px]">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded px-2 py-1 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <span className="ml-auto hidden text-[11px] text-neutral-400 sm:inline">
          PeraByte AI · internal
        </span>
      </div>
    </header>
  );
}
