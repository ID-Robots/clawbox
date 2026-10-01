// Which names a ClawBox user may be created with — TASK-1256.
//
// Every ClawBox user is a real Linux account, so a name that reaches
// `useradd` has to be one the OS would create AND one that cannot be mistaken
// for, or collide with, an account the box already depends on. Pure and
// dependency-free: the Settings → Users form checks a name as it is typed with
// the same rule the route enforces, and install.sh's step_user_add repeats the
// regex in root-owned code (the route's word is never the last one).
//
// What this module cannot know is which accounts THIS box has — `getent` is
// asked for that at create time (src/lib/clawbox-users.ts), so a name that is
// free of every rule here can still be refused as `exists`.

/**
 * The POSIX-portable login name useradd accepts by default, without the
 * trailing `$` machine-account form chpasswd.ts tolerates for the owner.
 * Lower-case letters, digits, `_` and `-`; must not start with a digit or
 * `-`; 1–32 characters.
 */
export const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Names that belong to the OS, the box's own services or an administrator
 * role. A Debian/Ubuntu/L4T image ships most of these as system accounts and
 * `getent` would refuse them anyway — they are listed so the refusal is the
 * right one ("reserved", not "exists") and so a name the image happens not to
 * carry today (`docker`, `admin`) cannot be taken by a person and later
 * collide with a package that expects it.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Base system accounts and groups.
  "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail", "news",
  "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats", "nobody",
  "nogroup", "adm", "tty", "disk", "kmem", "dialout", "fax", "voice", "cdrom",
  "floppy", "tape", "audio", "video", "plugdev", "staff", "users", "utmp",
  "shadow", "src", "sasl", "operator", "input", "render", "sgx", "kvm", "crontab",
  "netdev", "lxd", "i2c", "gpio", "tss", "uuidd", "tcpdump", "syslog",
  "messagebus", "sshd", "polkitd", "rtkit", "avahi", "avahi-autoipd", "dnsmasq",
  "usbmux", "pulse", "pulse-access", "colord", "geoclue", "saned", "lightdm",
  "gdm", "whoopsie", "kernoops", "speech-dispatcher", "hplip", "cups-pk-helper",
  "lpadmin", "scanner", "bluetooth", "ssl-cert", "fwupd-refresh", "landscape",
  "pollinate", "sambashare", "ntp", "chrony", "postfix", "docker", "ollama",
  "nvidia", "gnome-initial-setup", "nm-openvpn", "sssd", "systemd-journal",
  // Administrator roles a person must never be handed by picking a name.
  "sudo", "wheel", "admin", "administrator", "guest", "ubuntu", "jetson",
  // ClawBox's own accounts and groups.
  "clawbox", "clawbox-users", "openclaw",
  // Words the desktop's own routes use for "the signed-in user".
  "me", "self", "owner",
]);

/** Prefixes reserved as a family: systemd's dynamic accounts, Debian's `_apt` style, ClawBox's own. */
export const RESERVED_USERNAME_PREFIXES: readonly string[] = ["systemd-", "_", "clawbox"];

export type UsernameVerdict = "ok" | "invalid" | "reserved";

/** Judge a proposed NEW username by rule alone (no lookup of the box's accounts). */
export function checkUsername(name: unknown): UsernameVerdict {
  if (typeof name !== "string" || !USERNAME_RE.test(name)) return "invalid";
  if (RESERVED_USERNAMES.has(name)) return "reserved";
  if (RESERVED_USERNAME_PREFIXES.some((p) => name.startsWith(p))) return "reserved";
  return "ok";
}

/** Shortest and longest password the Users form and route accept for a new account. */
export const USER_PASSWORD_MIN = 8;
export const USER_PASSWORD_MAX = 256;
