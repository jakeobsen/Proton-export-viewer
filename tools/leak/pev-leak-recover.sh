#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# pev-leak-recover: undoes what pev-leak-capture leaves behind when it could
# not clean up itself (SIGKILL, a crash, or a restart during a phase).
#
#   sudo pev-leak-recover
#
# Root only, no arguments. It stops if a capture is still running, because
# that capture cleans up when it ends. Otherwise it:
#   - ends every process of the test user, while the block is still loaded;
#   - stops the tcpdump processes the capture started;
#   - flushes the capture's pf anchor and releases its pf reference;
#   - removes the test address from lo0 if the capture added it;
#   - removes /etc/resolver/test if it holds what the capture writes, and
#     /etc/resolver if the capture created it and it is empty;
#   - destroys pflog0 if the capture created it;
#   - marks the interrupted phase invalid and removes the capture lock.

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
# file, so never a symbolic link), is owned by root and is not writable by
# group or others.
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

require_root_owned "${BASE_DIR%/*/*}" d
require_root_owned "${BASE_DIR%/*}" d
require_root_owned "$BASE_DIR" d
require_root_owned "$CAPTURE_DIR" d
require_root_owned "$RUN_DIR" d

LOCK_DIR=$RUN_DIR/lock
if [ -d "$LOCK_DIR" ]; then
	_holder=$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)
	case "$_holder" in
	'' | *[!0-9]*) ;;
	*)
		if alive "$_holder"; then
			fail 75 "a capture is running (pid $_holder); stop it with SIGTERM instead"
		fi
		;;
	esac
fi

set +e
ERRORS=''

if /usr/bin/pgrep -U "$LEAK_USER" >/dev/null 2>&1; then
	/usr/bin/pkill -KILL -U "$LEAK_USER"
	_i=0
	while /usr/bin/pgrep -U "$LEAK_USER" >/dev/null 2>&1 && [ "$_i" -lt 10 ]; do
		/bin/sleep 1
		_i=$((_i + 1))
	done
	if /usr/bin/pgrep -U "$LEAK_USER" >/dev/null 2>&1; then
		ERRORS="$ERRORS $LEAK_USER-processes"
	else
		say "ended the processes of $LEAK_USER"
	fi
fi

if [ -f "$RUN_DIR/tcpdump-pids" ]; then
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
		fi
		say "stopped tcpdump (pid $_pid)"
	done
	/bin/rm -f "$RUN_DIR/tcpdump-pids"
fi

if /sbin/pfctl -a "$ANCHOR" -F rules >/dev/null 2>&1; then
	say "flushed the pf anchor $ANCHOR"
else
	ERRORS="$ERRORS anchor"
fi

if [ -f "$RUN_DIR/pf-token" ]; then
	_token=$(/bin/cat "$RUN_DIR/pf-token")
	case "$_token" in
	'' | *[!0-9]*) say 'ignored a malformed pf token' ;;
	*)
		if /sbin/pfctl -X "$_token" >/dev/null 2>&1; then
			say 'released the pf reference'
		else
			say 'the pf reference was no longer held (expected after a restart)'
		fi
		;;
	esac
	/bin/rm -f "$RUN_DIR/pf-token"
fi

if [ -f "$RUN_DIR/alias" ]; then
	_address=$(/bin/cat "$RUN_DIR/alias")
	case "$_address" in
	'' | *[!0-9a-f.:]*) ERRORS="$ERRORS alias-record" ;;
	*:*) _family=inet6 ;;
	*) _family=inet ;;
	esac
	if [ -n "${_family-}" ]; then
		if /sbin/ifconfig lo0 | /usr/bin/grep -Fq "$_family $_address "; then
			if /sbin/ifconfig lo0 "$_family" "$_address" -alias; then
				say "removed $_address from lo0"
			else
				ERRORS="$ERRORS alias"
			fi
		fi
		/bin/rm -f "$RUN_DIR/alias"
	fi
fi

if [ -f "$RESOLVER_FILE" ] && [ ! -L "$RESOLVER_FILE" ]; then
	_expected=$(printf 'nameserver 127.0.0.1\nport %s' "$STUB_PORT")
	if [ "$(/bin/cat "$RESOLVER_FILE")" = "$_expected" ]; then
		/bin/rm -f "$RESOLVER_FILE" && say "removed $RESOLVER_FILE"
	else
		say "left $RESOLVER_FILE in place: it is not the one the capture writes"
		ERRORS="$ERRORS resolver-file"
	fi
fi
if [ -f "$RUN_DIR/created-resolver-dir" ]; then
	/bin/rmdir "$RESOLVER_DIR" 2>/dev/null && say "removed $RESOLVER_DIR"
	/bin/rm -f "$RUN_DIR/created-resolver-dir"
fi

if [ -f "$RUN_DIR/created-pflog0" ]; then
	if /sbin/ifconfig pflog0 >/dev/null 2>&1; then
		if /sbin/ifconfig pflog0 destroy; then
			say 'destroyed pflog0'
		else
			ERRORS="$ERRORS pflog0"
		fi
	fi
	/bin/rm -f "$RUN_DIR/created-pflog0"
fi

if [ -f "$RUN_DIR/phase-dir" ]; then
	_dir=$(/bin/cat "$RUN_DIR/phase-dir")
	_name=${_dir#"$CAPTURE_DIR"/}
	case "$_name" in
	"$_dir" | */* | *..*) ;;
	[0-9]*T[0-9]*Z-*)
		if [ -d "$_dir" ]; then
			{
				echo 'result=invalid'
				echo 'reason=the capture stopped without cleaning up'
				echo "recovered=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
			} >>"$_dir/status"
			/bin/chmod 0644 "$_dir"/* 2>/dev/null
			say "marked $_dir invalid"
		fi
		;;
	esac
	/bin/rm -f "$RUN_DIR/phase-dir"
fi

/bin/rm -rf "$LOCK_DIR"

if [ -n "$ERRORS" ]; then
	echo "pev-leak-recover: not recovered:$ERRORS" >&2
	exit 1
fi
say finished
exit 0
