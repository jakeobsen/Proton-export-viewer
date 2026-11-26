#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# pev-leak-recover: undoes what pev-leak-capture left in place when it could
# not clean up itself (SIGKILL, a crash, a restart during a phase, or test-user
# processes that survived the phase).
#
#   sudo pev-leak-recover
#
# Root only, no arguments. It takes the capture lock: it refuses while a
# capture is starting or running, and takes over a lock whose capture has
# ended. It undoes only what the capture's records under run/ say that phase
# changed, and removes each record only once its change is undone; if
# something can't be undone, the record and the lock stay, so running it
# again retries. In order it:
#   - ends every process of the test user, while the block is still loaded;
#   - stops the capture's tcpdump processes;
#   - flushes the capture's pf anchor and releases its pf reference;
#   - removes the test address from lo0, /etc/resolver/test (only if it still
#     holds what the capture wrote), /etc/resolver and pflog0, each only if
#     the capture recorded creating it;
#   - marks the interrupted phase invalid and removes the lock.

set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
IFS=$(printf ' \t\n.')
IFS=${IFS%.}
LC_ALL=C
export LC_ALL
umask 022

if [ "$#" -ne 0 ]; then
	echo 'usage: pev-leak-recover (no arguments)' >&2
	exit 64
fi

ROOT_UID=0
LEAK_USER=pevleak
ANCHOR=com.apple/pev-leak
BASE_DIR=/usr/local/var/pev-leak
CAPTURE_DIR=/usr/local/var/pev-leak/captures
RUN_DIR=/usr/local/var/pev-leak/run
RESOLVER_DIR=/etc/resolver
RESOLVER_FILE=/etc/resolver/test
STUB_PORT=5354

fail() {
	_code=$1
	shift
	echo "pev-leak-recover: $*" >&2
	exit "$_code"
}

say() {
	echo "pev-leak-recover: $*"
}

[ "$(/usr/bin/id -u)" = "$ROOT_UID" ] || fail 77 'must run as root, through sudo'

# Fails unless $1 exists as type $2 ("d" for a directory, "-" for a regular
# file, so never a symbolic link), is owned by root, is not writable by
# group or others, and has no access control list.
require_root_owned() {
	_entry=$(/bin/ls -ldn "$1" 2>/dev/null) || fail 78 "missing: $1"
	set -f
	# shellcheck disable=SC2086 # split the ls fields
	set -- "$1" "$2" $_entry
	set +f
	case "$3" in
	"$2"*) ;;
	*) fail 78 "not the expected type: $1" ;;
	esac
	case "$3" in
	?????w* | ????????w*) fail 78 "writable by group or others: $1" ;;
	*+) fail 78 "has an access control list: $1" ;;
	esac
	[ "$5" = "$ROOT_UID" ] || fail 78 "not owned by root: $1"
}

# True while process $1 exists and is not a zombie.
alive() {
	_stat=$(/bin/ps -o stat= -p "$1" 2>/dev/null) || return 1
	case "$_stat" in
	'' | *Z*) return 1 ;;
	esac
	return 0
}

leak_processes() {
	/bin/ps -U "$LEAK_USER" -o pid=,ppid=,comm= 2>/dev/null || true
}

require_root_owned "${BASE_DIR%/*/*}" d
require_root_owned "${BASE_DIR%/*}" d
require_root_owned "$BASE_DIR" d
require_root_owned "$CAPTURE_DIR" d
require_root_owned "$RUN_DIR" d

# The capture lock: refuse while a capture is starting (no pid yet) or
# running; take over the lock of one that has ended.
LOCK_DIR=$RUN_DIR/lock
if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
	_holder=$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)
	case "$_holder" in
	'' | *[!0-9]*) fail 75 'a capture is starting; try again when it has started or ended' ;;
	esac
	if alive "$_holder"; then
		fail 75 "a capture is running (pid $_holder); stop it with SIGTERM instead"
	fi
fi
echo "$$" >"$LOCK_DIR/pid.new"
/bin/mv -f "$LOCK_DIR/pid.new" "$LOCK_DIR/pid"

set +e
ERRORS=''
PHASE_DIR=$(/bin/cat "$RUN_DIR/phase-dir" 2>/dev/null)
PHASE_ID=${PHASE_DIR##*/}
case "$PHASE_ID" in
[0-9]*T[0-9]*Z-*) ;;
*) PHASE_ID='' ;;
esac
if [ -n "$PHASE_ID" ] && [ "$PHASE_DIR" != "$CAPTURE_DIR/$PHASE_ID" ]; then
	PHASE_ID=''
fi

# True when the record $1 exists and belongs to the recorded phase.
owned() {
	[ -f "$RUN_DIR/$1" ] && [ -n "$PHASE_ID" ] && [ "$(/bin/cat "$RUN_DIR/$1")" = "$PHASE_ID" ]
}

# A record that exists but names another phase, or no phase, is left alone.
check_scope() {
	if [ -f "$RUN_DIR/$1" ] && ! owned "$1"; then
		say "left $RUN_DIR/$1: it doesn't belong to the recorded phase"
		ERRORS="$ERRORS $1"
	fi
}

_left=$(leak_processes)
if [ -n "$_left" ]; then
	if [ -n "$PHASE_ID" ] && [ -d "$PHASE_DIR" ]; then
		printf '%s\n' "$_left" >>"$PHASE_DIR/leftovers"
	fi
	/usr/bin/pkill -KILL -U "$LEAK_USER" 2>/dev/null
	_i=0
	while [ -n "$(leak_processes)" ] && [ "$_i" -lt 10 ]; do
		/bin/sleep 1
		_i=$((_i + 1))
	done
	if [ -n "$(leak_processes)" ]; then
		fail 1 "processes of $LEAK_USER survived; the block stays. Run this again later."
	fi
	say "ended the processes of $LEAK_USER"
fi

if [ -f "$RUN_DIR/tcpdump-pids" ]; then
	_stopped=1
	# shellcheck disable=SC2013 # one pid per word
	for _pid in $(/bin/cat "$RUN_DIR/tcpdump-pids"); do
		case "$_pid" in
		'' | *[!0-9]*) continue ;;
		esac
		alive "$_pid" || continue
		case "$(/bin/ps -o comm= -p "$_pid" 2>/dev/null)" in
		*tcpdump) ;;
		*) continue ;;
		esac
		kill -TERM "$_pid" 2>/dev/null
		_i=0
		while alive "$_pid" && [ "$_i" -lt 5 ]; do
			/bin/sleep 1
			_i=$((_i + 1))
		done
		if alive "$_pid"; then
			kill -KILL "$_pid" 2>/dev/null
			/bin/sleep 1
		fi
		if alive "$_pid"; then
			_stopped=0
		else
			say "stopped tcpdump (pid $_pid)"
		fi
	done
	if [ "$_stopped" = 1 ]; then
		/bin/rm -f "$RUN_DIR/tcpdump-pids"
	else
		ERRORS="$ERRORS tcpdump"
	fi
fi

if /sbin/pfctl -a "$ANCHOR" -F rules >/dev/null 2>&1; then
	say "flushed the pf anchor $ANCHOR"
	/bin/rm -f "$RUN_DIR/anchor"
else
	ERRORS="$ERRORS anchor"
fi

if [ -f "$RUN_DIR/pf-token" ]; then
	_token=$(/bin/cat "$RUN_DIR/pf-token")
	case "$_token" in
	'' | *[!0-9]*)
		say 'left a malformed pf token record'
		ERRORS="$ERRORS pf-token"
		;;
	*)
		if ! /sbin/pfctl -s References 2>/dev/null | /usr/bin/grep -Eq "(^|[^0-9])$_token([^0-9]|\$)"; then
			say 'the pf reference was no longer held (expected after a restart)'
			/bin/rm -f "$RUN_DIR/pf-token"
		elif /sbin/pfctl -X "$_token" >/dev/null 2>&1; then
			say 'released the pf reference'
			/bin/rm -f "$RUN_DIR/pf-token"
		else
			ERRORS="$ERRORS pf-token"
		fi
		;;
	esac
fi

if [ -f "$RUN_DIR/alias" ]; then
	_address=$(/bin/cat "$RUN_DIR/alias")
	_family=''
	case "$_address" in
	'' | *[!0-9a-f.:]*) ;;
	*:*) _family=inet6 ;;
	*) _family=inet ;;
	esac
	if [ -z "$_family" ]; then
		say 'left a malformed address record'
		ERRORS="$ERRORS alias"
	elif ! /sbin/ifconfig lo0 | /usr/bin/grep -Fq "$_family $_address "; then
		/bin/rm -f "$RUN_DIR/alias"
	elif /sbin/ifconfig lo0 "$_family" "$_address" -alias; then
		say "removed $_address from lo0"
		/bin/rm -f "$RUN_DIR/alias"
	else
		ERRORS="$ERRORS alias"
	fi
fi

check_scope created-resolver-file
if owned created-resolver-file; then
	_expected=$(printf 'nameserver 127.0.0.1\nport %s' "$STUB_PORT")
	if [ ! -e "$RESOLVER_FILE" ] && [ ! -L "$RESOLVER_FILE" ]; then
		/bin/rm -f "$RUN_DIR/created-resolver-file"
	elif [ -f "$RESOLVER_FILE" ] && [ ! -L "$RESOLVER_FILE" ] &&
		[ "$(/bin/cat "$RESOLVER_FILE")" = "$_expected" ]; then
		if /bin/rm -f "$RESOLVER_FILE"; then
			say "removed $RESOLVER_FILE"
			/bin/rm -f "$RUN_DIR/created-resolver-file"
		else
			ERRORS="$ERRORS resolver-file"
		fi
	else
		say "left $RESOLVER_FILE: it changed after the capture wrote it"
		ERRORS="$ERRORS resolver-file"
	fi
elif [ -e "$RESOLVER_FILE" ] && [ ! -f "$RUN_DIR/created-resolver-file" ]; then
	say "left $RESOLVER_FILE: no capture recorded creating it"
fi

check_scope created-resolver-dir
if owned created-resolver-dir; then
	/bin/rmdir "$RESOLVER_DIR" 2>/dev/null && say "removed $RESOLVER_DIR"
	if [ -d "$RESOLVER_DIR" ] && [ -z "$(/bin/ls -A "$RESOLVER_DIR")" ]; then
		ERRORS="$ERRORS resolver-dir"
	else
		/bin/rm -f "$RUN_DIR/created-resolver-dir"
	fi
fi

check_scope created-pflog0
if owned created-pflog0; then
	if ! /sbin/ifconfig pflog0 >/dev/null 2>&1; then
		/bin/rm -f "$RUN_DIR/created-pflog0"
	elif /sbin/ifconfig pflog0 destroy; then
		say 'destroyed pflog0'
		/bin/rm -f "$RUN_DIR/created-pflog0"
	else
		ERRORS="$ERRORS pflog0"
	fi
fi

if [ -n "$ERRORS" ]; then
	echo "pev-leak-recover: not recovered:$ERRORS; the lock stays, run this again" >&2
	exit 1
fi

if [ -n "$PHASE_ID" ] && [ -d "$PHASE_DIR" ]; then
	{
		echo 'result=invalid'
		echo 'reason=the capture did not clean up itself'
		echo "recovered=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >>"$PHASE_DIR/status"
	/bin/chmod 0644 "$PHASE_DIR"/* 2>/dev/null
	say "marked $PHASE_DIR invalid"
fi
/bin/rm -f "$RUN_DIR/phase-dir"
/bin/rm -rf "$LOCK_DIR"
say finished
exit 0
