#!/usr/bin/env bash
#
# Assert that every root command ClawBox runs through sudo is covered by the
# NOPASSWD allow-list we ship, and that the allow-list grants nothing we do not
# actually run.
#
# Why this exists (TASK-445): the drop-in on a provisioned device used to be a
# blanket `clawbox ALL=(ALL) NOPASSWD: ALL`. Narrowing it to an explicit list
# only STAYS narrow if something fails the build when a new `sudo` call shows up
# without a matching grant — otherwise the next developer hits a silent password
# prompt on an appliance with no console, "fixes" it by widening the list, and
# we are back where we started.
#
# The check is FAIL-CLOSED in both directions:
#
#   * A sudo call site whose argv this script cannot resolve to concrete
#     arguments is an ERROR. Write the call with literal arguments, declare its
#     expansion in DECLARED_ARGV, or exempt it in EXEMPT_CALLS with a reason.
#   * A grant nothing invokes is an ERROR, unless it is the `.service`/bare-unit
#     twin of a grant that IS invoked (see the header of config/clawbox-sudoers
#     for why both spellings are shipped) or is acknowledged in
#     ACKNOWLEDGED_UNUSED with a reason.
#
# It also enforces two SHAPE invariants on the allow-list itself, because
# coverage alone does not make a grant safe (TASK-445 audit, GAP 2 and GAP 3):
#
#   * NO WILDCARDS. sudoers(5) matches a command's arguments as one concatenated
#     string, so `*` and `?` span whitespace: `start --no-block clawbox-*` also
#     matched `start --no-block clawbox-setup.service ssh.service`, and
#     `systemctl start` takes a LIST of units. Every Cmnd_Spec must be literal,
#     path and arguments alike.
#   * ROOT-OWNED TARGETS ONLY. The command a grant names has to live somewhere
#     the clawbox user cannot write, or the grant hands root a file the web
#     server itself can rewrite. Anything outside the root-owned prefixes is
#     rejected — see ROOT_OWNED_PREFIXES below.
#
# Repo convention this relies on: a real sudo INVOCATION from TypeScript either
# spawns the literal "sudo"/"/usr/bin/sudo" as argv[0], or writes the absolute
# "/usr/bin/sudo" inside a generated shell script. A bare `sudo` inside a
# user-facing message ("Run: sudo apt install …") is prose, not an invocation,
# and is deliberately not matched.
#
# Usage:
#   bash scripts/check-sudoers-coverage.sh              # check, exit 1 on gaps
#   bash scripts/check-sudoers-coverage.sh --list       # dump grants + call sites
#   bash scripts/check-sudoers-coverage.sh --json       # machine-readable report

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAWBOX_REPO_ROOT:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"

MODE="check"
case "${1:-}" in
  --list) MODE="list" ;;
  --json) MODE="json" ;;
  "") ;;
  *)
    echo "usage: $0 [--list|--json]" >&2
    exit 2
    ;;
esac

if ! command -v perl >/dev/null 2>&1; then
  echo "check-sudoers-coverage: perl is required" >&2
  exit 2
fi

perl - "$REPO_ROOT" "$MODE" <<'PERL_EOF'
use strict;
use warnings;

my ($root, $mode) = @ARGV;

# Exit 1, never perl's errno-flavoured default: a malformed allow-list is the
# same kind of build failure as an uncovered call, and callers key on the code.
sub fatal { print STDERR "check-sudoers-coverage: $_[0]"; exit 1 }

# ── The sudoers drop-ins we ship ────────────────────────────────────────────
my @SUDOERS_FILES = (
  'config/clawbox-sudoers',
  'config/sudoers-clawbox-ollama',
);

# ── Where a granted command may live ────────────────────────────────────────
# Directories no unprivileged account on the appliance can write to.
# install.sh::install_root_libexec creates /usr/local/libexec/clawbox root:root
# 0755 under a root:root parent and copies every helper it grants into it,
# precisely so that no grant names a file in /home/clawbox/clawbox — a tree
# install.sh itself hands back to the clawbox user with `chown -R` on every root
# run.
my @ROOT_OWNED_PREFIXES = (
  '/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/local/libexec/clawbox/',
);

# Reject a grant that cannot be safe regardless of who invokes it.
sub check_grant_shape {
  my ($rel, $lineno, $cmd) = @_;

  if ($cmd =~ /[*?]/) {
    fatal("$rel:$lineno uses a wildcard:\n  $cmd\n"
      . "  sudoers matches arguments as ONE concatenated string, so `*` and `?` span\n"
      . "  whitespace and swallow extra arguments: a rule ending in `*` also matches\n"
      . "  `<granted command> <anything else>`. Enumerate the exact commands instead.\n");
  }

  my ($path) = split /\s+/, $cmd;
  fatal("$rel:$lineno grants the relative command `$path`. sudo resolves that through\n"
    . "  secure_path, which is a convenience, not a privilege boundary. Use an absolute path.\n")
    unless $path =~ m{^/};

  return if grep { index($path, $_) == 0 } @ROOT_OWNED_PREFIXES;
  fatal("$rel:$lineno grants `$path`, which is outside every root-owned prefix\n"
    . "  (" . join(', ', @ROOT_OWNED_PREFIXES) . ").\n"
    . "  A NOPASSWD grant on a file the clawbox user can write IS passwordless local root:\n"
    . "  the web server, the in-UI terminal and the agent's shell all run as clawbox.\n"
    . "  Install a root-owned copy under /usr/local/libexec/clawbox and grant that instead.\n");
}

# ── Where a root command may be invoked from ────────────────────────────────
# install.sh, config/clawbox-root-step.sh and e2e-install/ are deliberately
# absent: the first two only ever run AS root (`sudo bash install.sh`, or a
# systemd unit with no User=), and the third is a container harness, not
# product code. None of them crosses the clawbox -> root boundary this guards.
my @SCAN_DIRS = ('src', 'mcp', 'scripts');
my @SCAN_SKIP = ('src/tests/', 'node_modules/', '.next/');
my %SCAN_SKIP_FILE = ('scripts/check-sudoers-coverage.sh' => 1);

# ── Call sites whose argv is not a literal array ────────────────────────────
# Key   = "<repo-relative path> :: <argv source text, whitespace-collapsed>"
# Value = the concrete argument lists that call site can produce.
#
# Keying on the source text rather than a line number means unrelated edits
# above the call do not invalidate the declaration, but editing the CALL does:
# the key stops matching, the site becomes unresolved, and this check fails.
# That is the point — a new dynamic argument gets re-reviewed as a privilege
# boundary instead of inheriting someone else's review.
my %DECLARED_ARGV = (
  # src/lib/system-profile.ts — runScript() builds cmd = useSudo ? "sudo" :
  # script and argv = [script, ...args]. The two scripts do NOT share modes, so
  # this is enumerated per script rather than as a cartesian product; --check is
  # absent because the status path runs it without sudo.
  'src/lib/system-profile.ts :: cmd, argv' => [
    ['sudo', '/usr/local/libexec/clawbox/clawbox-desktop-mode.sh', '--enable'],
    ['sudo', '/usr/local/libexec/clawbox/clawbox-desktop-mode.sh', '--disable'],
    ['sudo', '/usr/local/libexec/clawbox/clawbox-power-mode.sh', '--balanced'],
    ['sudo', '/usr/local/libexec/clawbox/clawbox-power-mode.sh', '--performance'],
  ],
  # src/lib/local-models.ts — verb is enable|disable; unit is constrained to
  # SYSTEM_UNITS by the `allowed.has(unit)` guard immediately above the call.
  'src/lib/local-models.ts :: "/usr/bin/systemctl", verb, "--now", unit' => [
    ['/usr/bin/systemctl', 'enable', '--now', 'ollama.service'],
    ['/usr/bin/systemctl', 'disable', '--now', 'ollama.service'],
  ],
  # src/lib/local-ai-runtime.ts — systemctlOllama() is private to the module and
  # every caller passes one of the three module-level const argv arrays declared
  # right above it, each already a literal list. Enumerated here rather than
  # resolved because the call spreads them (`["-n", ...argv]`).
  'src/lib/local-ai-runtime.ts :: "-n", ...argv' => [
    ['-n', '/usr/bin/systemctl', 'enable', '--now', 'ollama.service'],
    ['-n', '/usr/bin/systemctl', 'start', 'ollama.service'],
    ['-n', '/usr/bin/systemctl', 'stop', 'ollama.service'],
  ],
  # src/app/setup-api/system/power/route.ts — POWER_ACTIONS maps the request
  # body to exactly these two; an unmapped action 400s before the call.
  'src/app/setup-api/system/power/route.ts :: "/usr/bin/systemctl", systemctlAction' => [
    ['/usr/bin/systemctl', 'poweroff'],
    ['/usr/bin/systemctl', 'reboot'],
  ],
  # src/app/setup-api/clawkeep/restore/route.ts — svc iterates RESTART_SERVICES.
  'src/app/setup-api/clawkeep/restore/route.ts :: "/usr/bin/systemctl", "restart", svc' => [
    ['/usr/bin/systemctl', 'restart', 'clawbox-gateway.service'],
  ],
);

# ── Sudo calls that are deliberately NOT in the allow-list ──────────────────
# Operator-driven paths where a password prompt is the correct behaviour, or
# grants we refuse to write because the target is clawbox-writable.
my %EXEMPT_CALLS = (
  'mcp/clawbox-cli.ts :: "bash", installScript' =>
    '`clawbox update` runs `sudo bash install.sh` from a human terminal. install.sh '
    . 'lives in the clawbox-writable project tree, so a NOPASSWD grant here would be '
    . 'the exact defect TASK-445 closed. The password prompt is the boundary.',
  'src/lib/hermes-cli.ts :: bin, argv' =>
    'runHermesCli({sudo:true}) execs HERMES_BIN under /home/clawbox/.local/bin, which '
    . 'the clawbox user owns and can rewrite. Deliberately ungranted: `sudo -n` fails '
    . 'closed in milliseconds rather than blocking a route handler on a prompt, and the '
    . 'alternative is passwordless root on a clawbox-writable file. Exactly ONE caller '
    . 'is left — the first-time `gateway install --system`, which '
    . 'writes a unit into /etc/systemd/system and has no safe Cmnd spelling. It is '
    . 'genuinely install-time-only, and its failure is now REPORTED (the `applied` flag) '
    . 'rather than swallowed. The RESTART branch used to be exempted under this same '
    . 'entry on the claim that it was install-time-only too; it was not — every '
    . 'Telegram/WhatsApp/Discord/Email config save hits it — so it moved to '
    . '`systemctl restart hermes-gateway.service`, which is granted.',
  'scripts/force-update.sh :: sudo -u %STR% bash -c %STR%' =>
    'Operator recovery script, run by hand from the Terminal app or over SSH. Dropping '
    . 'to the clawbox user is interactive by design — the owner types the password.',
  'scripts/force-update.sh :: sudo chown -R %STR% %STR%' =>
    'Same script. A NOPASSWD chown grant would hand the web server ownership of the git '
    . 'tree it is updated from, which is a root escalation in one move.',
);

# ── Grants nothing invokes, kept on purpose ─────────────────────────────────
my %ACKNOWLEDGED_UNUSED = (
  # 'the exact Cmnd string' => 'the operator path that still needs it',
);

# argv[0] is resolved through sudo's secure_path when it is not absolute.
my %BIN_PATH = (
  'systemctl' => '/usr/bin/systemctl',
  'apt-get'   => '/usr/bin/apt-get',
  'dpkg'      => '/usr/bin/dpkg',
  'snap'      => '/usr/bin/snap',
  'nmcli'     => '/usr/bin/nmcli',
);

# ── Load the allow-list ─────────────────────────────────────────────────────
my @grants;
for my $rel (@SUDOERS_FILES) {
  my $path = "$root/$rel";
  open(my $fh, '<', $path) or fatal("cannot read $rel: $!\n");
  my $lineno = 0;
  my $pending = '';
  while (my $line = <$fh>) {
    $lineno++;
    chomp $line;
    $line =~ s/^\s*#.*$//;
    next if $line =~ /^\s*$/ && $pending eq '';
    if ($line =~ s/\\\s*$//) { $pending .= $line; next; }
    my $full = $pending . $line;
    $pending = '';
    next if $full =~ /^\s*$/;
    if ($full =~ /^\s*clawbox\s+ALL\s*=\s*\(([^)]*)\)\s*NOPASSWD:\s*(.+?)\s*$/) {
      my ($runas, $cmd) = ($1, $2);
      $cmd =~ s/\s+/ /g;
      fatal("$rel:$lineno grants runas `$runas`; only (root) is allowed\n")
        unless $runas eq 'root';
      fatal("$rel:$lineno grants a bare ALL — that is the blanket rule this whole "
        . "task removed\n") if $cmd eq 'ALL';
      check_grant_shape($rel, $lineno, $cmd);
      push @grants, { file => $rel, line => $lineno, cmd => $cmd, used => 0 };
      next;
    }
    fatal("$rel:$lineno is not a `clawbox ALL=(root) NOPASSWD: <cmd>` rule:\n  $full\n");
  }
  close $fh;
}
fatal("no grants parsed\n") unless @grants;

# ── Collect the files to scan ───────────────────────────────────────────────
my @files;
sub walk {
  my ($dir) = @_;
  opendir(my $dh, "$root/$dir") or return;
  my @entries = sort grep { $_ ne '.' && $_ ne '..' } readdir($dh);
  closedir $dh;
  for my $e (@entries) {
    next if $e eq 'node_modules' || $e eq '.next';
    my $rel = "$dir/$e";
    if (-d "$root/$rel") { walk($rel); next; }
    next unless $rel =~ /\.(ts|tsx|js|mjs|sh)$/;
    next if $SCAN_SKIP_FILE{$rel};
    next if grep { index($rel, $_) == 0 } @SCAN_SKIP;
    push @files, $rel;
  }
}
walk($_) for @SCAN_DIRS;

# ── Resolve string constants ────────────────────────────────────────────────
my (%global_const, %global_conflict);
for my $rel (@files) {
  next unless $rel =~ /\.(ts|tsx)$/;
  open(my $fh, '<', "$root/$rel") or next;
  local $/;
  my $src = <$fh>;
  close $fh;
  while ($src =~ /^\s*export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*"([^"\\]*)"\s*;/mg) {
    my ($name, $val) = ($1, $2);
    $global_conflict{$name} = 1 if exists $global_const{$name} && $global_const{$name} ne $val;
    $global_const{$name} = $val;
  }
}

sub local_consts {
  my ($src) = @_;
  my %c;
  while ($src =~ /^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*"([^"\\]*)"\s*;/mg) {
    $c{$1} = $2;
  }
  return \%c;
}

my (@calls, @unresolved);

sub add_unresolved {
  my ($rel, $raw, $why) = @_;
  my $key = "$rel :: $raw";
  return if exists $EXEMPT_CALLS{$key};
  push @unresolved, { file => $rel, raw => $raw, why => $why, key => $key };
}

sub collapse {
  my ($s) = @_;
  $s =~ s{//[^\n]*}{}g;
  $s =~ s/\s+/ /g;
  $s =~ s/^\s+|\s+$//g;
  $s =~ s/,\s*$//;
  return $s;
}

sub split_argv_items {
  my ($text) = @_;
  my (@out, $cur, $depth, $quote);
  $cur = ''; $depth = 0; $quote = '';
  for my $ch (split //, $text) {
    if ($quote ne '') { $cur .= $ch; $quote = '' if $ch eq $quote; next; }
    if ($ch eq '"' || $ch eq "'" || $ch eq '`') { $quote = $ch; $cur .= $ch; next; }
    if ($ch =~ /[\(\[\{]/) { $depth++; $cur .= $ch; next; }
    if ($ch =~ /[\)\]\}]/) { $depth--; $cur .= $ch; next; }
    if ($ch eq ',' && $depth == 0) { push @out, $cur; $cur = ''; next; }
    $cur .= $ch;
  }
  push @out, $cur if $cur =~ /\S/;
  return map { my $s = $_; $s =~ s{//[^\n]*}{}g; $s =~ s/^\s+|\s+$//g; $s } @out;
}

sub resolve_items {
  my ($rel, $consts, $items) = @_;
  my @argv;
  for my $item (@$items) {
    next if $item eq '';
    if ($item =~ /^"([^"\\]*)"$/ || $item =~ /^'([^'\\]*)'$/ || $item =~ /^`([^`\\\$]*)`$/) {
      push @argv, $1;
    } elsif ($item =~ /^([A-Za-z_][A-Za-z0-9_]*)$/) {
      my $name = $1;
      if (exists $consts->{$name})                                        { push @argv, $consts->{$name} }
      elsif (exists $global_const{$name} && !$global_conflict{$name})     { push @argv, $global_const{$name} }
      else { return (undef, "identifier `$name` does not resolve to a string constant") }
    } else {
      return (undef, "argument `$item` is not a literal");
    }
  }
  return (\@argv, undef);
}

# ── TypeScript / JavaScript ─────────────────────────────────────────────────
my $SPAWNERS = qr/(?:execFileAsync|execFileSync|execFile|execAsync|execSync|spawnSync|spawn|runCommand|exec)/;

sub scan_ts {
  my ($rel, $raw) = @_;
  my $consts = local_consts($raw);

  # 1. spawn("sudo"|"/usr/bin/sudo", [ ...literal array... ])
  while ($raw =~ /$SPAWNERS\s*\(\s*"((?:\/usr\/bin\/)?sudo)"\s*,\s*\[([^\]]*)\]/gs) {
    my ($bin, $args_src) = ($1, $2);
    my $norm = collapse($args_src);
    if (my $declared = $DECLARED_ARGV{"$rel :: $norm"}) {
      push @calls, { file => $rel, argv => $_ } for @$declared;
      next;
    }
    my ($argv, $why) = resolve_items($rel, $consts, [split_argv_items($args_src)]);
    if (!$argv) { add_unresolved($rel, $norm, $why); next; }
    push @calls, { file => $rel, argv => [$bin, @$argv] };
  }

  # 2. A variable that may hold "sudo", spawned with a non-literal argv. This is
  #    how src/lib/system-profile.ts and src/lib/hermes-cli.ts branch between a
  #    privileged and an unprivileged exec, and it must not slip past silently.
  my %maybe_sudo;
  while ($raw =~ /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*([^;\n]*"(?:\/usr\/bin\/)?sudo"[^;\n]*);/g) {
    $maybe_sudo{$1} = 1;
  }
  while ($raw =~ /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*([^;\n]*\b([A-Z_][A-Z0-9_]*)\b[^;\n]*);/g) {
    my ($name, $rhs) = ($1, $2);
    $maybe_sudo{$name} = 1 if $rhs =~ /\bSUDO[A-Z0-9_]*\b/;
  }
  for my $var (sort keys %maybe_sudo) {
    while ($raw =~ /$SPAWNERS\s*\(\s*\Q$var\E\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/gs) {
      my $second = $1;
      my $norm = "$var, $second";
      if (my $declared = $DECLARED_ARGV{"$rel :: $norm"}) {
        push @calls, { file => $rel, argv => $_ } for @$declared;
        next;
      }
      add_unresolved($rel, $norm, "argv is built at runtime from `$var` / `$second`");
    }
    while ($raw =~ /$SPAWNERS\s*\(\s*\Q$var\E\s*,\s*\[([^\]]*)\]/gs) {
      my $args_src = $1;
      my $norm = collapse($args_src);
      if (my $declared = $DECLARED_ARGV{"$rel :: $norm"}) {
        push @calls, { file => $rel, argv => $_ } for @$declared;
        next;
      }
      add_unresolved($rel, $norm, "argv is spawned through `$var`, which may hold sudo");
    }
  }

  # 3. An absolute /usr/bin/sudo inside a generated shell script (template
  #    literal). Bare `sudo` in prose is deliberately not matched — see header.
  my $code = $raw;
  $code =~ s{/\*.*?\*/}{}gs;
  $code =~ s{^\s*//[^\n]*}{}mg;
  for my $line (split /\n/, $code) {
    next unless $line =~ m{(?:^|[\s;&|(])/usr/bin/sudo\s+(.+)$};
    my $rest = $1;
    $rest =~ s/\s+(?:\|\||&&|\||;|>|2>|`|\$\{).*$//;
    $rest =~ s/^\s+|\s+$//g;
    my @argv = split /\s+/, $rest;
    if (grep { /[\$"'`\\]/ } @argv) {
      add_unresolved($rel, "/usr/bin/sudo $rest", 'inline shell sudo has non-literal arguments');
      next;
    }
    push @calls, { file => $rel, argv => ['/usr/bin/sudo', @argv] };
  }
}

# ── Shell ───────────────────────────────────────────────────────────────────
# Quoted regions collapse to %STR% so `echo "… sudo …"` stops looking like an
# invocation, while `sudo tee "$f"` keeps its shape and is flagged as dynamic.
sub mask_shell_strings {
  my ($line) = @_;
  my ($out, $quote) = ('', '');
  for my $ch (split //, $line) {
    if ($quote ne '') { $quote = '' if $ch eq $quote; next; }
    if ($ch eq '"' || $ch eq "'") { $quote = $ch; $out .= "%STR%"; next; }
    $out .= $ch;
  }
  return $out;
}

sub scan_sh {
  my ($rel, $raw) = @_;
  for my $line (split /\n/, $raw) {
    next if $line =~ /^\s*#/;
    my $code = mask_shell_strings($line);
    $code =~ s/\s#\s.*$//;
    next unless $code =~ m{(?:^|[\s;&|(])(?:/usr/bin/)?sudo\s+(.+)$};
    my $rest = $1;
    $rest =~ s/\s+(?:\|\||&&|\||;|>|2>|\\\s*$).*$//;
    $rest =~ s/\s*\\\s*$//;
    $rest =~ s/^\s+|\s+$//g;
    my @argv = split /\s+/, $rest;
    shift @argv while @argv && ($argv[0] eq '-n' || $argv[0] eq '-E');
    if (grep { /[\$%*?]/ } @argv) {
      add_unresolved($rel, "sudo $rest", 'shell sudo call has non-literal arguments');
      next;
    }
    push @calls, { file => $rel, argv => \@argv };
  }
}

for my $rel (@files) {
  open(my $fh, '<', "$root/$rel") or next;
  local $/;
  my $src = <$fh>;
  close $fh;
  next unless defined $src && $src =~ /sudo/;
  if ($rel =~ /\.sh$/) { scan_sh($rel, $src) } else { scan_ts($rel, $src) }
}

# ── Match ───────────────────────────────────────────────────────────────────
sub normalize_argv {
  my ($argv) = @_;
  my @a = @$argv;
  shift @a if @a && ($a[0] eq 'sudo' || $a[0] eq '/usr/bin/sudo');
  while (@a && $a[0] =~ /^-/) {
    return (undef, "sudo option `$a[0]` changes the request; resolve it by hand")
      unless $a[0] eq '-n' || $a[0] eq '-E';
    shift @a;
  }
  return (undef, 'sudo invoked with no command') unless @a;
  if ($a[0] !~ m{^/}) {
    my $mapped = $BIN_PATH{$a[0]};
    return (undef, "argv[0] `$a[0]` has no known absolute path (add it to %BIN_PATH)")
      unless defined $mapped;
    $a[0] = $mapped;
  }
  return (\@a, undef);
}

# Exact comparison throughout: check_grant_shape() rejects `*` and `?` at parse
# time, so every grant is a literal command line and sudo's glob semantics — the
# ones that let `clawbox-*` swallow a second unit name — cannot apply here.
sub grant_matches {
  my ($grant, $argv) = @_;
  my ($gpath, @gargs) = split /\s+/, $grant;
  return 0 unless $gpath eq $argv->[0];
  # sudoers(5): a Cmnd listed without arguments may be run with any arguments.
  return 1 unless @gargs;
  return "@gargs" eq "@{$argv}[1 .. $#$argv]" ? 1 : 0;
}

my (@uncovered, %seen);
for my $call (@calls) {
  my ($argv, $why) = normalize_argv($call->{argv});
  if (!$argv) { add_unresolved($call->{file}, join(' ', @{$call->{argv}}), $why); next; }
  my $cmdline = join(' ', @$argv);
  my $hit = 0;
  for my $g (@grants) { if (grant_matches($g->{cmd}, $argv)) { $g->{used} = 1; $hit = 1 } }
  next if $hit;
  next if $seen{"$call->{file}|$cmdline"}++;
  push @uncovered, { file => $call->{file}, cmd => $cmdline };
}

# A grant is also "used" when it is the bare-unit twin of a used .service grant
# (or vice versa) — config/clawbox-sudoers ships both spellings on purpose.
my %used_cmd = map { $_->{cmd} => 1 } grep { $_->{used} } @grants;
for my $g (@grants) {
  next if $g->{used};
  my $twin = $g->{cmd};
  if ($twin =~ /\.service$/) { $twin =~ s/\.service$// } else { $twin .= '.service' }
  $g->{used} = 1 if $used_cmd{$twin};
}

my @unused = grep { !$_->{used} && !$ACKNOWLEDGED_UNUSED{$_->{cmd}} } @grants;

# ── Report ──────────────────────────────────────────────────────────────────
if ($mode eq 'list') {
  print "GRANTS (" . scalar(@grants) . "):\n";
  printf("  %-34s %s\n", "$_->{file}:$_->{line}", $_->{cmd}) for @grants;
  print "\nRESOLVED CALL SITES:\n";
  my %uniq;
  for my $c (@calls) {
    my ($argv) = normalize_argv($c->{argv});
    next unless $argv;
    my $line = sprintf("  %-50s sudo %s", $c->{file}, join(' ', @$argv));
    print "$line\n" unless $uniq{$line}++;
  }
  exit 0;
}

if ($mode eq 'json') {
  my $esc = sub { my $s = shift // ''; $s =~ s/(["\\])/\\$1/g; $s =~ s/\n/\\n/g; $s };
  my $arr = sub {
    my ($items, @keys) = @_;
    join(',', map { my $i = $_; '{' . join(',', map { qq("$_":") . $esc->($i->{$_}) . '"' } @keys) . '}' } @$items);
  };
  print "{\n";
  print qq(  "grants": ) . scalar(@grants) . ",\n";
  print qq(  "calls": ) . scalar(@calls) . ",\n";
  print qq(  "uncovered": [) . $arr->(\@uncovered, 'file', 'cmd') . "],\n";
  print qq(  "unresolved": [) . $arr->(\@unresolved, 'file', 'raw', 'why') . "],\n";
  print qq(  "unused": [) . $arr->(\@unused, 'file', 'cmd') . "]\n";
  print "}\n";
  exit((@uncovered || @unresolved || @unused) ? 1 : 0);
}

my $fail = 0;

if (@unresolved) {
  $fail = 1;
  print STDERR "\nUNRESOLVED sudo call sites (" . scalar(@unresolved) . "):\n";
  print STDERR "  This check is fail-closed. Give the call literal arguments, add an entry to\n";
  print STDERR "  DECLARED_ARGV in scripts/check-sudoers-coverage.sh, or exempt it in\n";
  print STDERR "  EXEMPT_CALLS with a reason.\n\n";
  print STDERR "  $_->{file}\n    key:  $_->{key}\n    why:  $_->{why}\n" for @unresolved;
}

if (@uncovered) {
  $fail = 1;
  print STDERR "\nUNCOVERED sudo invocations (" . scalar(@uncovered) . "):\n";
  print STDERR "  Nothing in " . join(' or ', @SUDOERS_FILES) . " grants these, so on a\n";
  print STDERR "  real device they hit a password prompt no one can answer.\n\n";
  print STDERR "  $_->{file}\n    sudo $_->{cmd}\n" for @uncovered;
}

if (@unused) {
  $fail = 1;
  print STDERR "\nUNUSED grants (" . scalar(@unused) . "):\n";
  print STDERR "  Nothing in the scanned tree invokes these. Remove them, or acknowledge them\n";
  print STDERR "  in ACKNOWLEDGED_UNUSED with the operator path that needs them.\n\n";
  print STDERR "  $_->{file}:$_->{line}  $_->{cmd}\n" for @unused;
}

if ($fail) {
  print STDERR "\ncheck-sudoers-coverage: FAILED\n";
  exit 1;
}

printf("check-sudoers-coverage: OK — %d grants, %d resolved sudo invocations, 0 gaps\n",
       scalar(@grants), scalar(@calls));
exit 0;
PERL_EOF
