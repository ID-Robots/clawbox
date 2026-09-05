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
#   * A DECLARED_ARGV entry is VERIFIED against the code, not trusted. Every
#     dynamic argument in the declared call has to name the symbol its values
#     come from; that symbol is re-resolved on every run and the declaration
#     fails the build the moment the two disagree. An argument that genuinely
#     cannot be resolved goes in `unverified` with a reason, and is reviewed
#     like a grant.
#   * A DECLARED_ARGV or EXEMPT_CALLS entry that matches nothing is an ERROR.
#     A reviewed decision must not outlive the call site it was made about.
#
# The third rule is not theoretical. `for (const svc of
# restartServicesFor(getEdition()))` in the ClawKeep restore route kept its
# source text byte-for-byte while the helper behind it grew a Hermes branch
# restarting clawbox-hermes-dashboard.service. The hand-written declaration
# still said the site only ever restarts clawbox-gateway.service, so this check
# reported "0 gaps" — and the owner's restore on a real Hermes box put every
# file back and then could not restart the dashboard.
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

  # sudo matches the command PATH as a string and does not canonicalise it, so
  # `/usr/bin/../home/clawbox/clawbox/payload` would sail past the prefix test
  # below while naming a file in the clawbox-writable tree. Only canonical paths
  # can be reasoned about here.
  fatal("$rel:$lineno grants `$path`, which contains a `.` or `..` component.\n"
    . "  sudo compares the command path as a string and never canonicalises it, so a\n"
    . "  traversal like /usr/bin/../home/clawbox/... would pass the root-owned prefix\n"
    . "  check below while naming a file clawbox can write. Use the canonical path.\n")
    if grep { $_ eq '.' || $_ eq '..' } split m{/}, $path;

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
# Value = { argv => [...], resolve => {...}, unverified => {...} }
#
#   argv       the concrete argument lists this call site can produce.
#   resolve    { <dynamic item> => <symbol> | [<symbol>, ...] }. The symbol is
#              RE-RESOLVED out of the file on every run and `argv` is checked
#              against it, so the declaration is verified rather than trusted.
#   unverified { <dynamic item> => 'why the resolver cannot see it' }. Reviewed
#              like a grant, because nothing else is checking it.
#
# Keying on the source text means unrelated edits above the call do not
# invalidate the declaration, but editing the CALL does: the key stops matching,
# the site becomes unresolved, and this check fails.
#
# THAT WAS NOT ENOUGH, and the gap it left shipped. When a call takes its
# argument from a helper — `for (const svc of restartServicesFor(getEdition()))`
# — the helper can grow a whole new unit without the call text changing by a
# byte. The hand-written `argv` below then quietly stops being the truth: the
# declaration said the site only ever restarts `clawbox-gateway.service`, the
# code had grown a Hermes branch restarting `clawbox-hermes-dashboard.service`,
# and this check reported "0 gaps" while that restart failed on every Hermes
# device it ran on.
#
# So the source text is no longer the only thing pinned. Every non-literal item
# in the key must be listed in `resolve` (verified against the code) or in
# `unverified` (with a reason). An item in neither is a hard failure, a
# `resolve` whose value set no longer matches `argv` is a hard failure, and a
# declaration whose call site has disappeared is a hard failure too — a stale
# declaration is how a reviewed decision outlives the code it was about.
my %DECLARED_ARGV = (
  # src/lib/system-profile.ts — runScript() builds cmd = useSudo ? "sudo" :
  # script and argv = [script, ...args]. The two scripts do NOT share modes, so
  # this is enumerated per script rather than as a cartesian product; --check is
  # absent because the status path runs it without sudo.
  'src/lib/system-profile.ts :: cmd, argv' => {
    argv => [
      ['sudo', '/usr/local/libexec/clawbox/clawbox-desktop-mode.sh', '--enable'],
      ['sudo', '/usr/local/libexec/clawbox/clawbox-desktop-mode.sh', '--disable'],
      ['sudo', '/usr/local/libexec/clawbox/clawbox-power-mode.sh', '--balanced'],
      ['sudo', '/usr/local/libexec/clawbox/clawbox-power-mode.sh', '--performance'],
    ],
    unverified => {
      cmd  => 'runScript() sets cmd = useSudo ? "sudo" : script — a branch on its own '
            . 'parameter, not a value set anything can enumerate from the file.',
      argv => 'argv = [script, ...args], assembled from runScript()\'s parameters at each '
            . 'call site rather than from a table. The four lists above are every MUTATING '
            . 'caller; the --check modes are absent because the status path runs them with '
            . 'no sudo at all.',
    },
  },
  # src/lib/local-models.ts — verb is enable|disable; unit is constrained to
  # SYSTEM_UNITS by the `allowed.has(unit)` guard immediately above the call.
  'src/lib/local-models.ts :: "/usr/bin/systemctl", verb, "--now", unit' => {
    argv => [
      ['/usr/bin/systemctl', 'enable', '--now', 'ollama.service'],
      ['/usr/bin/systemctl', 'disable', '--now', 'ollama.service'],
    ],
    resolve    => { unit => 'SYSTEM_UNITS' },
    unverified => {
      verb => 'enable|disable, chosen from a boolean by the caller. A parameter, not a '
            . 'table — but it can only ever be one of those two spellings, and both are '
            . 'enumerated above.',
    },
  },
  # src/lib/local-ai-runtime.ts — systemctlOllama() is private to the module and
  # every caller passes one of the three module-level const argv arrays declared
  # right above it. The CONTENTS of those three arrays are re-resolved on every
  # run, so a `--now` or a unit rename inside one fails this check instead of
  # failing on a device.
  'src/lib/local-ai-runtime.ts :: "-n", ...argv' => {
    argv => [
      ['-n', '/usr/bin/systemctl', 'enable', '--now', 'ollama.service'],
      ['-n', '/usr/bin/systemctl', 'start', 'ollama.service'],
      ['-n', '/usr/bin/systemctl', 'stop', 'ollama.service'],
      ['-n', '/usr/bin/systemctl', 'start', 'clawbox-embed.service'],
      ['-n', '/usr/bin/systemctl', 'stop', 'clawbox-embed.service'],
    ],
    resolve => {
      '...argv' => ['OLLAMA_ENABLE_NOW_ARGV', 'OLLAMA_START_ARGV', 'OLLAMA_STOP_ARGV',
                    'EMBED_START_ARGV', 'EMBED_STOP_ARGV'],
    },
  },
  # src/app/setup-api/system/power/route.ts — POWER_ACTIONS maps the request
  # body to exactly these two; an unmapped action 400s before the call.
  'src/app/setup-api/system/power/route.ts :: "/usr/bin/systemctl", systemctlAction' => {
    argv => [
      ['/usr/bin/systemctl', 'poweroff'],
      ['/usr/bin/systemctl', 'reboot'],
    ],
    resolve => { systemctlAction => 'POWER_ACTIONS' },
  },
  # src/lib/root-step-runner.ts — startRootStep() builds ["-n", LAUNCHER, ...].
  # The step name is NOT enumerated here, and that is the design: the grant names
  # the launcher with no argument spec, and the launcher decides which unit it
  # will start by checking the step against its own WEB_ROOT_STEPS list, in
  # root-owned code. src/tests/unit/root-steps.test.ts pins that list to
  # src/lib/root-steps.ts. Enumerating 25 step names in a sudoers Cmnd_Spec would
  # be 50 lines of string matching doing worse than one root-side check.
  'src/lib/root-step-runner.ts :: "/usr/bin/sudo", argv' => {
    argv => [
      ['-n', '/usr/local/libexec/clawbox/clawbox-run-root-step.sh', 'chpasswd'],
      ['-n', '/usr/local/libexec/clawbox/clawbox-run-root-step.sh', '--no-block', 'llamacpp_install'],
    ],
    unverified => {
      argv => 'startRootStep() builds the list imperatively — `const argv = ["-n", '
            . 'ROOT_STEP_LAUNCHER]`, then an optional `--no-block`, then the step — so it is '
            . 'not one const array a symbol lookup could read back. Both shapes it can '
            . 'produce are declared above. The STEP is deliberately not enumerated: the '
            . 'grant names the launcher with no argument spec, and the launcher checks the '
            . 'step against WEB_ROOT_STEPS in root-owned code (config/clawbox-run-root-step.sh), '
            . 'which src/tests/unit/root-steps.test.ts pins to src/lib/root-steps.ts.',
    },
  },
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

# ── Verifying a declaration against the code it describes ───────────────────
#
# A DECLARED_ARGV entry is a hand-written claim about what a call site can
# produce, and an unchecked claim rots the moment its producer changes. That is
# not hypothetical: the ClawKeep restore declaration kept saying
# "clawbox-gateway.service" long after the route had grown a Hermes branch
# restarting clawbox-hermes-dashboard.service, and this check reported "0 gaps"
# while that restart failed on every Hermes device.
#
# Everything below re-derives the claim from the source on every run, so the
# claim fails the build instead of the device.

my (%DECL_USED, %DECL_VERIFIED, %EXEMPT_USED);

# Comments come out before any symbol lookup: an apostrophe in prose would
# otherwise open a "string" and swallow the brace matching below.
sub strip_ts_comments {
  my ($src) = @_;
  my ($out, $i, $n) = ('', 0, length $src);
  while ($i < $n) {
    my $two = substr($src, $i, 2);
    if ($two eq '//') { $i += 2; $i++ while $i < $n && substr($src, $i, 1) ne "\n"; next }
    if ($two eq '/*') { $i += 2; $i++ while $i < $n && substr($src, $i, 2) ne '*/'; $i += 2; next }
    my $ch = substr($src, $i, 1);
    if ($ch eq '"' || $ch eq "'" || $ch eq '`') {
      my $q = $ch;
      $out .= $ch;
      $i++;
      while ($i < $n) {
        my $c = substr($src, $i, 1);
        $out .= $c;
        $i++;
        last if $c eq $q;
        if ($c eq '\\' && $i < $n) { $out .= substr($src, $i, 1); $i++ }
      }
      next;
    }
    $out .= $ch;
    $i++;
  }
  return $out;
}

# The inner text of the balanced group $text starts with, quotes respected.
sub balanced_group {
  my ($text, $open, $close) = @_;
  return undef unless length($text) && substr($text, 0, 1) eq $open;
  my ($depth, $i, $n) = (0, 0, length $text);
  while ($i < $n) {
    my $ch = substr($text, $i, 1);
    if ($ch eq '"' || $ch eq "'" || $ch eq '`') {
      my $q = $ch;
      $i++;
      while ($i < $n) {
        my $c = substr($text, $i, 1);
        $i++;
        last if $c eq $q;
        $i++ if $c eq '\\';
      }
      next;
    }
    if ($ch eq $open) { $depth++ }
    elsif ($ch eq $close) {
      $depth--;
      return substr($text, 1, $i - 1) if $depth == 0;
    }
    $i++;
  }
  return undef;
}

# Where a symbol's values live: ('array'|'object'|'function', the inner text).
sub symbol_definition {
  my ($src, $name) = @_;
  if ($src =~ /(?:^|[^A-Za-z0-9_\$])(?:export\s+)?(?:const|let|var)\s+\Q$name\E\s*(?::[^=\n]*)?=\s*/g) {
    my $rest = substr($src, pos($src));
    $rest =~ s/^new\s+(?:Set|Map)\s*\(\s*//;
    return ('array',  balanced_group($rest, '[', ']')) if substr($rest, 0, 1) eq '[';
    return ('object', balanced_group($rest, '{', '}')) if substr($rest, 0, 1) eq '{';
    return ('opaque', undef);
  }
  if ($src =~ /(?:^|[^A-Za-z0-9_\$])(?:export\s+)?(?:async\s+)?function\s+\Q$name\E\s*(?=\()/g) {
    my $rest = substr($src, pos($src));
    my $params = balanced_group($rest, '(', ')');
    return ('opaque', undef) unless defined $params;
    my $after = substr($rest, length($params) + 2);
    $after =~ s/^[^{]*//s;
    return ('function', balanced_group($after, '{', '}'));
  }
  return (undef, undef);
}

# The text of every `return …;` in a function body. Quotes and brackets are
# respected so a `;` inside a string or a nested literal does not end the
# expression early.
sub return_expressions {
  my ($body) = @_;
  my @out;
  my ($i, $n) = (0, length $body);
  while ($i < $n) {
    my $ch = substr($body, $i, 1);
    if ($ch eq '"' || $ch eq "'" || $ch eq '`') {
      my $q = $ch;
      $i++;
      # ord(), not a backslash literal: this file is a shell heredoc wrapping a
      # perl script, and a lone `\` in it has three layers to survive.
      while ($i < $n) { my $c = substr($body, $i, 1); $i++; last if $c eq $q; $i++ if ord($c) == 92 }
      next;
    }
    if (substr($body, $i, 6) eq 'return'
        && ($i == 0 || substr($body, $i - 1, 1) !~ /[A-Za-z0-9_\$]/)
        && ($i + 6 >= $n || substr($body, $i + 6, 1) !~ /[A-Za-z0-9_\$]/)) {
      my $j = $i + 6;
      my $start = $j;
      my $depth = 0;
      while ($j < $n) {
        my $c = substr($body, $j, 1);
        if ($c eq '"' || $c eq "'" || $c eq '`') {
          my $q = $c;
          $j++;
          while ($j < $n) { my $d = substr($body, $j, 1); $j++; last if $d eq $q; $j++ if ord($d) == 92 }
          next;
        }
        $depth++ if $c =~ /[\(\[\{]/;
        $depth-- if $c =~ /[\)\]\}]/;
        last if $depth < 0;
        last if $c eq ';' && $depth == 0;
        $j++;
      }
      push @out, substr($body, $start, $j - $start);
      $i = $j + 1;
      next;
    }
    $i++;
  }
  return @out;
}

sub unquote {
  my ($s) = @_;
  return $1 if $s =~ /^"([^"\\]*)"$/;
  return $1 if $s =~ /^'([^'\\]*)'$/;
  return $1 if $s =~ /^`([^`\\\$]*)`$/;
  return undef;
}

# Every value a symbol can contribute.
#   want 'scalar' -> one [value] per array element / Set member / map value
#   want 'list'   -> one arrayref per array literal, kept whole (for a spread)
sub resolve_symbol_values {
  my ($key, $rel, $clean, $consts, $name, $want) = @_;
  my ($kind, $body) = symbol_definition($clean, $name);
  fatal("DECLARED_ARGV{$key}\n"
      . "  `resolve` names `$name`, which $rel does not define as a const array, Set, object\n"
      . "  literal or function. Point it at the symbol that really holds the values, or move\n"
      . "  the argument to `unverified` with the reason it cannot be resolved.\n")
    unless defined $kind && $kind ne 'opaque' && defined $body;

  my @groups;
  if ($kind eq 'array') {
    push @groups, [split_argv_items($body)];
  } elsif ($kind eq 'object') {
    my @items;
    while ($body =~ /(?:^|[,{])\s*(?:"[^"]*"|'[^']*'|\[[^\]]*\]|[A-Za-z_\$][A-Za-z0-9_\$]*)\s*:\s*("[^"\\]*"|'[^'\\]*'|[A-Za-z_\$][A-Za-z0-9_\$]*)/g) {
      push @items, $1;
    }
    push @groups, \@items;
  } else {
    # A function: the array literals in its RETURN expressions, and nothing
    # else. Two narrowings, both deliberate:
    #
    #   * array literals only, not every string. Harvesting the whole body
    #     would collect the operands of `edition === "hermes"` as if they were
    #     unit names.
    #   * return expressions only. An unrelated array elsewhere in the body —
    #     a validation list, an error message built from a template literal —
    #     would otherwise be demanded as a privileged argument, and the cheapest
    #     way to silence that is to ADD a grant for it. A check that pushes the
    #     next author towards widening the allow-list is worse than no check.
    #
    # A helper whose return is not a literal array contributes nothing and
    # fails the "yielded no values" test below, which is the fail-closed
    # answer: point `resolve` at the symbol that holds the values, or say in
    # `unverified` why it cannot be resolved.
    for my $expr (return_expressions($body)) {
      my ($i, $n) = (0, length $expr);
      while ($i < $n) {
        if (substr($expr, $i, 1) eq '[') {
          my $g = balanced_group(substr($expr, $i), '[', ']');
          if (defined $g) { push @groups, [split_argv_items($g)]; $i += length($g) + 2; next }
        }
        $i++;
      }
    }
  }

  my @out;
  for my $g (@groups) {
    next unless @$g;
    my ($argv, $why) = resolve_items($rel, $consts, $g);
    fatal("DECLARED_ARGV{$key}\n"
        . "  cannot read the values of `$name` in $rel: $why.\n"
        . "  Give it string literals or string constants, or move the argument to\n"
        . "  `unverified` with a reason.\n")
      unless $argv;
    if ($want eq 'list') { push @out, $argv }
    else { push @out, map { [$_] } @$argv }
  }
  fatal("DECLARED_ARGV{$key}\n"
      . "  `$name` in $rel yielded no values at all, so nothing was verified. A declaration\n"
      . "  that silently checks nothing is the failure mode this whole mechanism is for.\n")
    unless @out;
  return \@out;
}

sub report_drift {
  my ($key, $what, $want, $got, $symbols) = @_;
  my @missing = grep { !$got->{$_} } sort keys %$want;
  my @extra   = grep { !$want->{$_} } sort keys %$got;
  return unless @missing || @extra;
  my $show = sub { join('', map { '    ' . join(' ', split /\0/, $_) . "\n" } @{ $_[0] }) };
  my $msg = "DECLARED_ARGV{$key}\n"
          . "  no longer describes the code. $what resolves out of "
          . join(', ', @$symbols) . " to a different\n  set of values than the declaration lists.\n";
  $msg .= "  produced by the code, missing from the declaration:\n" . $show->(\@missing) if @missing;
  $msg .= "  listed in the declaration, no longer produced by the code:\n" . $show->(\@extra) if @extra;
  $msg .= "  Update `argv` to match — then check the allow-list still covers every line of it,\n"
        . "  because a new value here is a new privileged command, and that is what this catches.\n";
  fatal($msg);
}

sub verify_declaration {
  my ($key, $tmpl_src, $decl, $rel, $src, $consts) = @_;

  fatal("DECLARED_ARGV{$key}\n  must be a hash with an `argv` list of argument lists.\n")
    unless ref $decl eq 'HASH' && ref $decl->{argv} eq 'ARRAY' && @{ $decl->{argv} };
  my $resolve    = $decl->{resolve}    || {};
  my $unverified = $decl->{unverified} || {};

  my @tmpl = split_argv_items($tmpl_src);
  my @dyn;
  for my $i (0 .. $#tmpl) {
    next if defined unquote($tmpl[$i]);
    push @dyn, { idx => $i, name => $tmpl[$i] };
  }

  # Fail-closed in both directions: nothing dynamic goes undeclared, and nothing
  # declared outlives the argument it was about.
  for my $d (@dyn) {
    next if exists $resolve->{ $d->{name} } || exists $unverified->{ $d->{name} };
    fatal("DECLARED_ARGV{$key}\n"
        . "  says nothing about the dynamic argument `$d->{name}`.\n"
        . "  Add it to `resolve`, naming the symbol that holds its values so this check can\n"
        . "  verify the declaration against the code, or to `unverified` with the reason it\n"
        . "  cannot be. A dynamic argument nobody described is how a new privileged command\n"
        . "  reaches a device without a grant.\n");
  }
  my %is_dyn = map { $_->{name} => 1 } @dyn;
  for my $name (sort(keys %$resolve), sort(keys %$unverified)) {
    next if $is_dyn{$name};
    fatal("DECLARED_ARGV{$key}\n"
        . "  describes `$name`, which this call site no longer passes. Drop it, or re-point it\n"
        . "  at the argument the call really builds.\n");
  }
  for my $name (sort keys %$unverified) {
    fatal("DECLARED_ARGV{$key}\n  `unverified` entry `$name` needs a reason, not an empty string.\n")
      unless defined $unverified->{$name} && $unverified->{$name} =~ /\S/;
  }
  return unless %$resolve;

  my $clean = strip_ts_comments($src);
  my @spread = grep { $_->{name} =~ /^\.\.\./ } @dyn;

  if (@spread) {
    fatal("DECLARED_ARGV{$key}\n"
        . "  mixes a spread with another dynamic argument. A spread can only be verified when\n"
        . "  every other item in the call is a literal; mark them `unverified` instead.\n")
      if @spread > 1 || @dyn > 1;
    my $sp = $spread[0];
    my $syms = $resolve->{ $sp->{name} };
    my @symbols = ref $syms eq 'ARRAY' ? @$syms : ($syms);
    my %want;
    for my $sym (@symbols) {
      $want{ join("\0", @$_) } = 1
        for @{ resolve_symbol_values($key, $rel, $clean, $consts, $sym, 'list') };
    }
    my @before = map { unquote($tmpl[$_]) } (0 .. $sp->{idx} - 1);
    my @after  = map { unquote($tmpl[$_]) } ($sp->{idx} + 1 .. $#tmpl);
    my %got;
    for my $a (@{ $decl->{argv} }) {
      my @c = @$a;
      fatal("DECLARED_ARGV{$key}\n  a declared argv is shorter than the literals around the spread.\n")
        if @c < @before + @after;
      for my $j (0 .. $#before) {
        fatal("DECLARED_ARGV{$key}\n"
            . "  argument $j is the literal `$before[$j]` in the call but `$c[$j]` in a declared\n"
            . "  argv. The declaration does not describe this call site.\n")
          unless $c[$j] eq $before[$j];
      }
      for my $j (0 .. $#after) {
        my $pos = scalar(@c) - scalar(@after) + $j;
        fatal("DECLARED_ARGV{$key}\n"
            . "  the trailing literal `$after[$j]` is `$c[$pos]` in a declared argv.\n")
          unless $c[$pos] eq $after[$j];
      }
      splice(@c, scalar(@c) - scalar(@after), scalar @after) if @after;
      splice(@c, 0, scalar @before) if @before;
      $got{ join("\0", @c) } = 1;
    }
    report_drift($key, "the spread `$sp->{name}`", \%want, \%got, \@symbols);
    return;
  }

  my $n = scalar @tmpl;
  fatal("DECLARED_ARGV{$key}\n"
      . "  has `resolve` entries, but the declared argument lists are not the same length as\n"
      . "  the call's own argument list, so there is no position to verify them against.\n"
      . "  Declare the argv the call really passes, or mark every dynamic item `unverified`.\n")
    if grep { scalar @$_ != $n } @{ $decl->{argv} };

  for my $i (0 .. $#tmpl) {
    my $lit = unquote($tmpl[$i]);
    next unless defined $lit;
    for my $a (@{ $decl->{argv} }) {
      fatal("DECLARED_ARGV{$key}\n"
          . "  argument $i is the literal `$lit` in the call but `$a->[$i]` in a declared argv.\n"
          . "  The declaration does not describe this call site.\n")
        unless $a->[$i] eq $lit;
    }
  }
  for my $d (@dyn) {
    next unless exists $resolve->{ $d->{name} };
    my $syms = $resolve->{ $d->{name} };
    my @symbols = ref $syms eq 'ARRAY' ? @$syms : ($syms);
    my %want;
    for my $sym (@symbols) {
      $want{ $_->[0] } = 1
        for @{ resolve_symbol_values($key, $rel, $clean, $consts, $sym, 'scalar') };
    }
    my %got = map { $_->[ $d->{idx} ] => 1 } @{ $decl->{argv} };
    report_drift($key, "`$d->{name}`", \%want, \%got, \@symbols);
  }
}

# The one entry point the scanners use: look the declaration up, verify it
# against the file it describes, and hand back the argument lists.
sub declared_argv {
  my ($rel, $norm, $src, $consts) = @_;
  my $key = "$rel :: $norm";
  my $decl = $DECLARED_ARGV{$key} or return undef;
  $DECL_USED{$key} = 1;
  verify_declaration($key, $norm, $decl, $rel, $src, $consts) unless $DECL_VERIFIED{$key}++;
  return $decl->{argv};
}

my (@calls, @unresolved);

sub add_unresolved {
  my ($rel, $raw, $why) = @_;
  my $key = "$rel :: $raw";
  if (exists $EXEMPT_CALLS{$key}) { $EXEMPT_USED{$key} = 1; return }
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
    if (my $declared = declared_argv($rel, $norm, $raw, $consts)) {
      push @calls, { file => $rel, argv => $_ } for @$declared;
      next;
    }
    my ($argv, $why) = resolve_items($rel, $consts, [split_argv_items($args_src)]);
    if (!$argv) { add_unresolved($rel, $norm, $why); next; }
    push @calls, { file => $rel, argv => [$bin, @$argv] };
  }

  # 1b. spawn("sudo"|"/usr/bin/sudo", argv) where argv is a VARIABLE. The
  #     literal-array form above cannot see this, and without it a helper that
  #     builds its own argument list is invisible to the whole check — its grant
  #     reads as unused and a new one would read as covered.
  while ($raw =~ /$SPAWNERS\s*\(\s*"((?:\/usr\/bin\/)?sudo)"\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/gs) {
    my ($bin, $var) = ($1, $2);
    my $norm = "\"$bin\", $var";
    if (my $declared = declared_argv($rel, $norm, $raw, $consts)) {
      push @calls, { file => $rel, argv => $_ } for @$declared;
      next;
    }
    add_unresolved($rel, $norm, "argv is built at runtime in `$var`");
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
      if (my $declared = declared_argv($rel, $norm, $raw, $consts)) {
        push @calls, { file => $rel, argv => $_ } for @$declared;
        next;
      }
      add_unresolved($rel, $norm, "argv is built at runtime from `$var` / `$second`");
    }
    while ($raw =~ /$SPAWNERS\s*\(\s*\Q$var\E\s*,\s*\[([^\]]*)\]/gs) {
      my $args_src = $1;
      my $norm = collapse($args_src);
      if (my $declared = declared_argv($rel, $norm, $raw, $consts)) {
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

# ── Nothing described here may outlive the code it described ────────────────
# A declaration or an exemption is a reviewed decision about one call site. When
# that call site changes shape or goes away, the decision has to be re-made, not
# inherited: a leftover entry is a standing permission to skip a check, keyed on
# text nothing in the tree produces any more.
for my $key (sort keys %DECLARED_ARGV) {
  next if $DECL_USED{$key};
  fatal("DECLARED_ARGV{$key}
"
      . "  matches no sudo call site in the tree. The call it described was edited, moved or
"
      . "  removed; delete the entry, or re-key it on the call as it is written now so it is
"
      . "  reviewed against today's code instead of yesterday's.
");
}
for my $key (sort keys %EXEMPT_CALLS) {
  next if $EXEMPT_USED{$key};
  fatal("EXEMPT_CALLS{$key}
"
      . "  matches no unresolved sudo call site. Either the call is gone, or it now resolves
"
      . "  and is being checked properly — both mean the exemption is a permission nobody is
"
      . "  using. Delete it.
");
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
