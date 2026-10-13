/**
 * The Google Chrome mark for the desktop's Google Chrome icon: three 120°
 * sectors (red top, yellow right, green left) around a white ring and a blue
 * centre.
 */
export default function GoogleChromeIcon({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <path d="M24 24 L4.95 13 A22 22 0 0 1 43.05 13 Z" fill="#ea4335" />
      <path d="M24 24 L43.05 13 A22 22 0 0 1 24 46 Z" fill="#fbbc04" />
      <path d="M24 24 L24 46 A22 22 0 0 1 4.95 13 Z" fill="#34a853" />
      <circle cx="24" cy="24" r="10" fill="#fff" />
      <circle cx="24" cy="24" r="8" fill="#1a73e8" />
    </svg>
  );
}
