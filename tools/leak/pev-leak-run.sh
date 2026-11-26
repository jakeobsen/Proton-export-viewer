#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# pev-leak-run: starts one staged program as the leak-test user.
#
# Installed under four names, one per program. Each has its own sudoers rule
# that lets it run as the test user with no arguments:
#   pev-leak-run-standard   the standard packaged test build   stage/standard.app
#   pev-leak-run-mas        the Mac App Store test build       stage/mas.app
#   pev-leak-run-probe      the control and marker script      stage/probe.mjs
#   pev-leak-run-consent    the consent DNS check              stage/consent.mjs
#
# The stage directory belongs to the user who runs the harness, who copies
# the builds and scripts there, and the inputs for one launch into
# stage/input/<name>.json. The program runs with a fixed environment and
# reads that input on standard input, so a sandboxed build needs no access to
# the stage. Its standard output and error go into a new directory under
# results/, which the test user owns and everyone can read. launch.txt there
# records the digests of the program and the input it was given, the start
# and end times, and the exit status.
#
# results/ and the test user's home (its state, temporary files and app
# containers) share one size limit. It is checked before the launch, with
# room kept for the launch's output, and every 5 seconds while the program
# runs. Reaching it, or the time limit, stops the program and makes the
# launch invalid: launch.txt says why, and the launcher exits 75.
#
# A test build is started with --pev-leak; the standard build also gets an
# empty user data directory in the test user's home.

set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
IFS=$(printf ' \t\n.')
IFS=${IFS%.}
LC_ALL=C
export LC_ALL
umask 022

case "${0##*/}" in
pev-leak-run-standard) NAME=pev-leak-run-standard TARGET=standard KIND=app ;;
pev-leak-run-mas) NAME=pev-leak-run-mas TARGET=mas KIND=app ;;
pev-leak-run-probe) NAME=pev-leak-run-probe TARGET=probe KIND=node ;;
pev-leak-run-consent) NAME=pev-leak-run-consent TARGET=consent KIND=node ;;
*)
	echo 'pev-leak-run: install as pev-leak-run-standard, -mas, -probe or -consent' >&2
	exit 64
	;;
esac
if [ "$#" -ne 0 ]; then
	echo "usage: $NAME (no arguments)" >&2
	exit 64
fi

LEAK_USER=pevleak
STAGE_DIR=/usr/local/var/pev-leak/stage
RESULTS_DIR=/usr/local/var/pev-leak/results
LEAK_HOME=/usr/local/var/pev-leak/home
NODE=/opt/homebrew/bin/node
# Limits: 10 minutes per launch, then SIGTERM and 10 s later SIGKILL; 64 KiB
# of input; 8 MiB per file the program writes (ulimit -f counts 512-byte
# blocks); the newest 60 result directories; 40 MiB for results/ and the test
# user's home together, with 16 MiB of it free before each launch.
MAX_SECONDS=600
MAX_INPUT_BYTES=65536
FILE_BLOCKS=16384
KEEP_RESULTS=60
TRANSIENT_CAP_KB=40960
HEADROOM_KB=16384

fail() {
	_code=$1
	shift
	echo "$NAME: $*" >&2
	exit "$_code"
}

[ "$(/usr/bin/id -un)" = "$LEAK_USER" ] || fail 77 "must run as $LEAK_USER, through sudo"

# True while process $1 exists and is not a zombie.
alive() {
	_stat=$(/bin/ps -o stat= -p "$1" 2>/dev/null) || return 1
	case "$_stat" in
	'' | *Z*) return 1 ;;
	esac
	return 0
}

stamp() {
	/bin/date -u +%Y-%m-%dT%H:%M:%SZ
}

# Prints the SHA-256 of a file, or of a directory tree: the hash of the
# bytewise-sorted list of "<SHA-256>  <path>" for each regular file and
# "link  <path> -> <target>" for each symbolic link, paths relative to the
# tree. pev-leak-digest.sh holds the same function, so a copy can be checked
# against its original.
digest() {
	if [ -d "$1" ] && [ ! -L "$1" ]; then
		(
			cd "$1" || exit 1
			/usr/bin/find . -type f -exec /usr/bin/shasum -a 256 {} +
			# shellcheck disable=SC2016 # expanded by the inner shell
			/usr/bin/find . -type l -exec /bin/sh -c '
				for p do printf "link  %s -> %s\n" "$p" "$(/usr/bin/readlink "$p")"; done
			' sh {} +
		) | LC_ALL=C /usr/bin/sort | /usr/bin/shasum -a 256 | /usr/bin/cut -c1-64
	else
		/usr/bin/shasum -a 256 <"$1" | /usr/bin/cut -c1-64
	fi
}

# KiB used by results/ and the test user's home together. Fails when du
# can't measure both.
transient_kb() {
	_out=$(/usr/bin/du -sk "$RESULTS_DIR" "$LEAK_HOME" 2>/dev/null || true)
	_sum=0
	_seen=0
	while read -r _kb _path; do
		case "$_kb" in
		'' | *[!0-9]*) continue ;;
		esac
		_sum=$((_sum + _kb))
		_seen=$((_seen + 1))
	done <<EOF
$_out
EOF
	[ "$_seen" -eq 2 ] || return 1
	echo "$_sum"
}

# Keeps the newest KEEP_RESULTS - 1 result directories, fewer while results/
# and the home together leave less than HEADROOM_KB below the limit, then
# refuses if that room still isn't there.
prune_results() {
	set -f
	_names=$(/bin/ls -1 "$RESULTS_DIR" | LC_ALL=C /usr/bin/sort)
	_count=0
	# shellcheck disable=SC2086 # one name per line, globbing is off
	for _name in $_names; do
		_count=$((_count + 1))
	done
	# shellcheck disable=SC2086 # one name per line, globbing is off
	for _name in $_names; do
		_kb=$(transient_kb) || fail 75 "can't measure $RESULTS_DIR and $LEAK_HOME"
		if [ "$_count" -lt "$KEEP_RESULTS" ] && [ $((_kb + HEADROOM_KB)) -le "$TRANSIENT_CAP_KB" ]; then
			break
		fi
		case "$_name" in
		[0-9]*T[0-9]*Z-*) /bin/rm -rf "${RESULTS_DIR:?}/$_name" ;;
		*) fail 78 "unexpected entry in $RESULTS_DIR: $_name" ;;
		esac
		_count=$((_count - 1))
	done
	set +f
	_kb=$(transient_kb) || fail 75 "can't measure $RESULTS_DIR and $LEAK_HOME"
	if [ $((_kb + HEADROOM_KB)) -gt "$TRANSIENT_CAP_KB" ]; then
		fail 75 "$RESULTS_DIR and $LEAK_HOME use $_kb KiB; a launch needs them under $((TRANSIENT_CAP_KB - HEADROOM_KB)) KiB"
	fi
}

require_file() {
	if [ ! -f "$1" ] || [ -L "$1" ]; then
		fail 66 "not a regular file: $1"
	fi
}

case "$KIND" in
app)
	BUNDLE=$STAGE_DIR/$TARGET.app
	if [ ! -d "$BUNDLE" ] || [ -L "$BUNDLE" ]; then
		fail 66 "not a directory: $BUNDLE"
	fi
	require_file "$BUNDLE/Contents/Info.plist"
	EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$BUNDLE/Contents/Info.plist") ||
		fail 66 "no CFBundleExecutable in $BUNDLE/Contents/Info.plist"
	case "$EXECUTABLE" in
	'' | .* | *[!A-Za-z0-9\ ._-]*) fail 65 "unexpected CFBundleExecutable in $BUNDLE" ;;
	esac
	PROGRAM=$BUNDLE/Contents/MacOS/$EXECUTABLE
	require_file "$PROGRAM"
	[ -x "$PROGRAM" ] || fail 66 "not executable: $PROGRAM"
	DIGEST_OF=$BUNDLE
	;;
node)
	PROGRAM=$STAGE_DIR/$TARGET.mjs
	require_file "$PROGRAM"
	DIGEST_OF=$PROGRAM
	;;
esac
INPUT=$STAGE_DIR/input/$TARGET.json
require_file "$INPUT"
_bytes=$(/usr/bin/wc -c <"$INPUT")
_bytes=$((_bytes + 0))
[ "$_bytes" -le "$MAX_INPUT_BYTES" ] || fail 65 "$INPUT is larger than $MAX_INPUT_BYTES bytes"

prune_results
OUT=$RESULTS_DIR/$(/bin/date -u +%Y%m%dT%H%M%SZ)-$TARGET-$$
/bin/mkdir -m 0755 "$OUT"
echo "$NAME: results $OUT"

record() {
	echo "$1" >>"$OUT/launch.txt"
}

# SIGTERM, SIGINT and SIGHUP (sudo passes them on) stop the program, also
# when they arrive before it has started.
CHILD=''
STOP=0
# shellcheck disable=SC2317 # runs from the signal traps
stop_program() {
	STOP=1
	if [ -n "$CHILD" ]; then
		kill -TERM "$CHILD" 2>/dev/null || true
	fi
}
trap stop_program TERM INT HUP

record "launcher=$NAME"
record "user=$(/usr/bin/id -un)"
record "started=$(stamp)"
record "program=$DIGEST_OF"
record "program_digest=$(digest "$DIGEST_OF")"
record "input_digest=$(digest "$INPUT")"

if [ ! -d "$LEAK_HOME/tmp" ]; then
	/bin/mkdir -m 0700 "$LEAK_HOME/tmp"
fi
case "$TARGET" in
standard)
	/bin/rm -rf "$LEAK_HOME/state/standard"
	if [ ! -d "$LEAK_HOME/state" ]; then
		/bin/mkdir -m 0700 "$LEAK_HOME/state"
	fi
	/bin/mkdir -m 0700 "$LEAK_HOME/state/standard"
	set -- --pev-leak "--pev-user-data=$LEAK_HOME/state/standard"
	;;
mas)
	set -- --pev-leak
	;;
probe | consent)
	record "node=$NODE"
	record "node_digest=$(digest "$NODE")"
	set -- "$PROGRAM"
	PROGRAM=$NODE
	;;
esac

if [ "$STOP" = 1 ]; then
	record 'stopped=before the program started'
	exit 143
fi
ulimit -f "$FILE_BLOCKS"
/usr/bin/env -i \
	HOME="$LEAK_HOME" TMPDIR="$LEAK_HOME/tmp/" PATH="$PATH" \
	USER="$LEAK_USER" LOGNAME="$LEAK_USER" \
	"$PROGRAM" "$@" <"$INPUT" >"$OUT/stdout.txt" 2>"$OUT/stderr.txt" &
CHILD=$!
if [ "$STOP" = 1 ]; then
	kill -TERM "$CHILD" 2>/dev/null || true
fi

# Stops the program at the time limit or the size limit and writes which one
# to $OUT/invalid. It polls once a second, measures every 5 seconds, and ends
# as soon as the program has, so it leaves no process behind.
STARTED=$(/bin/date +%s)
(
	_tick=0
	while alive "$CHILD"; do
		_why=''
		if [ $(($(/bin/date +%s) - STARTED)) -ge "$MAX_SECONDS" ]; then
			_why='time limit reached'
		elif [ $((_tick % 5)) -eq 4 ]; then
			if ! _kb=$(transient_kb); then
				_why='size limit could not be measured'
			elif [ "$_kb" -gt "$TRANSIENT_CAP_KB" ]; then
				_why="size limit reached ($_kb KiB)"
			fi
		fi
		if [ -n "$_why" ]; then
			echo "$_why" >"$OUT/invalid"
			kill -TERM "$CHILD" 2>/dev/null
			_m=0
			while alive "$CHILD" && [ "$_m" -lt 10 ]; do
				/bin/sleep 1
				_m=$((_m + 1))
			done
			kill -KILL "$CHILD" 2>/dev/null
			exit 0
		fi
		/bin/sleep 1
		_tick=$((_tick + 1))
	done
) &
WATCHDOG=$!

# wait returns early when a trapped signal arrives; then wait again.
STATUS=0
wait "$CHILD" || STATUS=$?
while alive "$CHILD"; do
	STATUS=0
	wait "$CHILD" || STATUS=$?
done
if [ "$STATUS" -gt 128 ]; then
	_status=0
	wait "$CHILD" 2>/dev/null || _status=$?
	[ "$_status" -eq 127 ] || STATUS=$_status
fi
wait "$WATCHDOG" 2>/dev/null || true
trap - TERM INT HUP

record "exit=$STATUS"
record "ended=$(stamp)"
if [ -f "$OUT/invalid" ]; then
	_why=$(/bin/cat "$OUT/invalid")
	/bin/rm -f "$OUT/invalid"
	record "invalid=$_why"
	echo "$NAME: invalid ($_why)"
	exit 75
fi
echo "$NAME: exit $STATUS"
exit "$STATUS"
