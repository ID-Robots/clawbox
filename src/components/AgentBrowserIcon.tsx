/**
 * The Agent Browser's mark: a browser window with the assistant's face in it.
 *
 * Both words of the name, because the app is not "a browser for you" — that
 * is `web`, the plain globe — but the Chromium the assistant drives, shown on
 * the device's own screen. It wore a Chrome-style roundel while it was called
 * "Browser", which said the first thing and not the second.
 *
 * Drawn in `currentColor`, with the eyes CUT OUT of the head (evenodd) rather
 * than painted in a tile colour: the same drawing sits on the desktop's blue
 * tile and on the app header's orange one.
 */
export default function AgentBrowserIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="agent-browser-icon"
    >
      {/* The window, its title bar and two of its buttons. */}
      <rect x="2.5" y="3.5" width="19" height="17" rx="3.2" />
      <path d="M2.5 8h19" />
      <circle cx="5.9" cy="5.8" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8.2" cy="5.8" r="0.7" fill="currentColor" stroke="none" />
      {/* The assistant: a head with two eyes, and its ears. */}
      <path
        fill="currentColor"
        stroke="none"
        fillRule="evenodd"
        d="M9.3 11.2h5.4a1.8 1.8 0 0 1 1.8 1.8v2.7a1.8 1.8 0 0 1-1.8 1.8H9.3a1.8 1.8 0 0 1-1.8-1.8V13a1.8 1.8 0 0 1 1.8-1.8zM9.25 14.1a.95.95 0 1 0 1.9 0a.95.95 0 1 0-1.9 0zM12.85 14.1a.95.95 0 1 0 1.9 0a.95.95 0 1 0-1.9 0z"
      />
      <path d="M6.2 13.9v1M17.8 13.9v1" strokeWidth={1.6} />
    </svg>
  );
}
