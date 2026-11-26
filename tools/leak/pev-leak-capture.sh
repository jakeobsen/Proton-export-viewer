#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# pev-leak-capture: blocks and records every TCP and UDP packet the leak-test
# user sends during one test phase.
#
#   pev-leak-capture controls|zero|consent
#
# Runs as root through sudo, one capture at a time. For the phase it:
#   - ends system agents that launchd left running as the test user, and
#     refuses to start while any other process of that user runs;
#   - loads a pf sub-anchor under com.apple/* that blocks and logs every TCP
#     and UDP packet of the test user on every interface, loopback included
#     (consent: TCP to the test address on port 80 is passed and logged);
#   - records pflog0, filtered to that anchor, and lo0 at the DNS stub's port
#     into pcap files in a root-owned directory, readable in place;
#   - sends every .test name to the DNS stub at 127.0.0.1:5354;
#   - consent only: adds the test address to lo0.
# It prints "ready" once all of that is in place and runs until SIGTERM. The
# phase is complete only if, when SIGTERM arrives, it is within its time and
# size limits and both captures still run, and if neither capture then
# reports dropped packets. Anything else marks it invalid in its status file.
#
# Teardown first ends every process of the test user and lists them in the
# phase directory. System agents (parent launchd, executable under
# /usr/libexec, /usr/sbin or /System) are expected; any other process makes
# the phase invalid. If a process survives, the block, the resolver file,
# the address and the lock all stay in place for pev-leak-recover.
#
# Each change is recorded under run/ before it is made, with the phase it
# belongs to, and its record is removed only once the change is undone.
# While the phase is being set up, SIGTERM, SIGINT and SIGHUP are only noted;
# the capture acts on them after each change and its record, so a signal
# never leaves a change without its record. The output of "pfctl -E" goes to
# a file under run/ first, so even after SIGKILL the reference can be
# released; only if pfctl itself is killed before printing its token does
# pev-leak-recover report a pf reference it can't identify.
#
# The lock is built under a temporary name with the pid inside, then renamed
# into place, so a lock always names its holder.
#
# The argument only selects one of three fixed settings. It never becomes part
# of a path or a command line.

set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
IFS=$(printf ' \t\n.')
IFS=${IFS%.}
LC_ALL=C
export LC_ALL
umask 022

usage() {
	echo 'usage: pev-leak-capture controls|zero|consent' >&2
	exit 64
}

[ "$#" -eq 1 ] || usage
case "$1" in
controls) PHASE=controls CONSENT=0 ;;
zero) PHASE=zero CONSENT=0 ;;
consent) PHASE=consent CONSENT=1 ;;
*) usage ;;
esac

ROOT_UID=0
LEAK_USER=pevleak
ANCHOR=com.apple/pev-leak
ANCHOR_NAME=pev-leak
BASE_DIR=/usr/local/var/pev-leak
CAPTURE_DIR=/usr/local/var/pev-leak/captures
RUN_DIR=/usr/local/var/pev-leak/run
CONFIG_DIR=/usr/local/etc/pev-leak
CONFIG_FILE=/usr/local/etc/pev-leak/test-address
RESOLVER_DIR=/etc/resolver
RESOLVER_FILE=/etc/resolver/test
STUB_PORT=5354
# Limits: 15 minutes per phase; 5 MB of pcaps per phase; the newest 15 phases
# kept; 100 MB for the whole capture directory. Each tcpdump also stops by
# itself after MAX_PACKETS packets of at most SNAPLEN bytes, so the pcaps stay
# under the phase limit even between two size checks.
MAX_SECONDS=900
PHASE_CAP_BYTES=5242880
KEEP_PHASES=15
CAPTURE_DIR_CAP_BYTES=104857600
SNAPLEN=1024
MAX_PACKETS=2000
READY_WAIT=10

RESULT=''
REASON=''

fail() {
	_code=$1
	shift
	echo "pev-leak-capture: $*" >&2
	[ -n "$REASON" ] || REASON=$*
	exit "$_code"
}

# shellcheck disable=SC2317 # also called from cleanup, which the EXIT trap runs
add_reason() {
	REASON="${REASON:+$REASON; }$1"
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

# True when process $1 is alive and is a capture or a recovery, so a pid
# reused after a restart doesn't count as the lock's holder.
holder_alive() {
	alive "$1" || return 1
	case "$(/bin/ps -o command= -p "$1" 2>/dev/null)" in
	*pev-leak-capture* | *pev-leak-recover*) return 0 ;;
	esac
	return 1
}

stamp() {
	/bin/date -u +%Y-%m-%dT%H:%M:%SZ
}

# Accepts one IPv4 address in dotted-decimal form (no leading zeros) outside
# every private, shared, loopback, link-local, multicast, reserved,
# benchmarking and documentation range. Sets FAMILY to inet.
valid_ipv4() {
	case "$1" in
	'' | *[!0-9.]*) return 1 ;;
	esac
	_octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])'
	printf '%s\n' "$1" | /usr/bin/grep -Eq "^$_octet(\\.$_octet){3}\$" || return 1
	_saved_ifs=$IFS
	IFS=.
	set -f
	# shellcheck disable=SC2086 # split into octets
	set -- $1
	set +f
	IFS=$_saved_ifs
	case "$1" in
	0 | 10 | 127) return 1 ;;
	esac
	[ "$1" -lt 224 ] || return 1
	[ "$1" -ne 100 ] || [ "$2" -lt 64 ] || [ "$2" -gt 127 ] || return 1
	[ "$1" -ne 169 ] || [ "$2" -ne 254 ] || return 1
	[ "$1" -ne 172 ] || [ "$2" -lt 16 ] || [ "$2" -gt 31 ] || return 1
	[ "$1" -ne 192 ] || [ "$2" -ne 168 ] || return 1
	[ "$1" -ne 192 ] || [ "$2" -ne 0 ] || [ "$3" -ne 0 ] || return 1
	[ "$1" -ne 192 ] || [ "$2" -ne 0 ] || [ "$3" -ne 2 ] || return 1
	[ "$1" -ne 192 ] || [ "$2" -ne 88 ] || [ "$3" -ne 99 ] || return 1
	[ "$1" -ne 198 ] || [ "$2" -lt 18 ] || [ "$2" -gt 19 ] || return 1
	[ "$1" -ne 198 ] || [ "$2" -ne 51 ] || [ "$3" -ne 100 ] || return 1
	[ "$1" -ne 203 ] || [ "$2" -ne 0 ] || [ "$3" -ne 113 ] || return 1
	FAMILY=inet
}

# Accepts one IPv6 address in lowercase hex without leading zeros in a group,
# inside 2000::/3 and outside 2001::/23, 2001:db8::/32, 2002::/16 and
# 3fff::/20. Sets FAMILY to inet6. read_test_address also requires the form
# ifconfig prints (see ipv6_canonical).
valid_ipv6() {
	case "$1" in
	'' | *[!0-9a-f:]*) return 1 ;;
	esac
	_g='(0|[1-9a-f][0-9a-f]{0,3})'
	_re="($_g:){7}$_g"
	_re="$_re|($_g:){1,7}:"
	_re="$_re|($_g:){1,6}:$_g"
	_re="$_re|($_g:){1,5}(:$_g){1,2}"
	_re="$_re|($_g:){1,4}(:$_g){1,3}"
	_re="$_re|($_g:){1,3}(:$_g){1,4}"
	_re="$_re|($_g:){1,2}(:$_g){1,5}"
	_re="$_re|$_g:(:$_g){1,6}"
	printf '%s\n' "$1" | /usr/bin/grep -Eq "^($_re)\$" || return 1
	case "$1" in
	[23][0-9a-f][0-9a-f][0-9a-f]:*) ;;
	*) return 1 ;;
	esac
	case "$1" in
	2001::* | 2001:[0-9a-f]:* | 2001:[0-9a-f][0-9a-f]:* | 2001:1[0-9a-f][0-9a-f]:*) return 1 ;;
	2001:db8:* | 2002:*) return 1 ;;
	3fff::* | 3fff:[0-9a-f]:* | 3fff:[0-9a-f][0-9a-f]:* | 3fff:[0-9a-f][0-9a-f][0-9a-f]:*) return 1 ;;
	esac
	FAMILY=inet6
}

# Prints an address that valid_ipv6 accepted in the form ifconfig prints
# (RFC 5952): all eight groups, with the longest run of two or more zero
# groups (the first one, on a tie) written as "::".
ipv6_canonical() {
	_head=$1
	_tail=''
	case "$1" in
	*::*)
		_head=${1%%::*}
		_tail=${1#*::}
		;;
	esac
	IFS=:
	set -f
	# shellcheck disable=SC2086 # split into groups
	set -- $_head
	_groups="$*"
	_count=$#
	# shellcheck disable=SC2086 # split into groups
	set -- $_tail
	_count=$((_count + $#))
	while [ "$_count" -lt 8 ]; do
		_groups="${_groups:+$_groups:}0"
		_count=$((_count + 1))
	done
	_groups="$_groups${_tail:+:$_tail}"
	# shellcheck disable=SC2086 # split into groups
	set -- $_groups
	set +f
	IFS=$(printf ' \t\n.')
	IFS=${IFS%.}
	_best_at=0
	_best_len=0
	_run_at=0
	_run_len=0
	_i=1
	for _group do
		if [ "$_group" = 0 ]; then
			[ "$_run_len" -gt 0 ] || _run_at=$_i
			_run_len=$((_run_len + 1))
			if [ "$_run_len" -gt "$_best_len" ]; then
				_best_at=$_run_at
				_best_len=$_run_len
			fi
		else
			_run_len=0
		fi
		_i=$((_i + 1))
	done
	_left=''
	_right=''
	_i=1
	for _group do
		if [ "$_best_len" -lt 2 ] || [ "$_i" -lt "$_best_at" ]; then
			_left="${_left:+$_left:}$_group"
		elif [ "$_i" -ge $((_best_at + _best_len)) ]; then
			_right="${_right:+$_right:}$_group"
		fi
		_i=$((_i + 1))
	done
	if [ "$_best_len" -lt 2 ]; then
		echo "$_left"
	else
		echo "$_left::$_right"
	fi
}

# Reads the test address: one line in a root-owned file, never sourced.
read_test_address() {
	require_root_owned "${CONFIG_DIR%/*}" d
	require_root_owned "$CONFIG_DIR" d
	require_root_owned "$CONFIG_FILE" -
	_bytes=$(/usr/bin/wc -c <"$CONFIG_FILE")
	_bytes=$((_bytes + 0))
	[ "$_bytes" -le 64 ] || fail 78 "$CONFIG_FILE: longer than one address"
	TEST_ADDRESS=$(/bin/cat "$CONFIG_FILE")
	case "$TEST_ADDRESS" in
	*[!0-9a-f.:]*) fail 78 "$CONFIG_FILE: not a single IP address" ;;
	esac
	if valid_ipv4 "$TEST_ADDRESS"; then
		return 0
	fi
	valid_ipv6 "$TEST_ADDRESS" || fail 78 "$CONFIG_FILE: not a global unicast IP address"
	# The alias checks compare text with what ifconfig prints, so only that
	# spelling is accepted.
	_canonical=$(ipv6_canonical "$TEST_ADDRESS")
	[ "$_canonical" = "$TEST_ADDRESS" ] ||
		fail 78 "$CONFIG_FILE: write the address as $_canonical (the form ifconfig prints)"
}

# The test user's processes, one "pid ppid executable" line each.
leak_processes() {
	/bin/ps -U "$LEAK_USER" -o pid=,ppid=,comm= 2>/dev/null || true
}

# True when every line of $1 is a system agent: launchd (pid 1) is its
# parent and its executable is under /usr/libexec, /usr/sbin or /System.
only_system_agents() {
	while read -r _pid _ppid _exe; do
		[ -n "$_pid" ] || continue
		[ "$_ppid" = 1 ] || return 1
		case "$_exe" in
		/usr/libexec/* | /usr/sbin/* | /System/*) ;;
		*) return 1 ;;
		esac
	done <<EOF
$1
EOF
	return 0
}

# Ends every process of the test user. Fails if one is still running after
# 10 seconds.
end_leak_processes() {
	/usr/bin/pkill -KILL -U "$LEAK_USER" 2>/dev/null
	_i=0
	while [ -n "$(leak_processes)" ] && [ "$_i" -lt 10 ]; do
		/bin/sleep 1
		_i=$((_i + 1))
	done
	[ -z "$(leak_processes)" ]
}

# Sum of the phase's pcap sizes, in bytes.
pcap_bytes() {
	_total=0
	for _file in "$PHASE_DIR/pflog0.pcap" "$PHASE_DIR/stub.pcap"; do
		[ -f "$_file" ] || continue
		_size=$(/usr/bin/wc -c <"$_file")
		_total=$((_total + _size))
	done
	echo "$_total"
}

# Keeps the newest KEEP_PHASES - 1 phase directories, so that there are at
# most KEEP_PHASES with the new one, then checks the directory's total.
prune_captures() {
	set -f
	_names=$(/bin/ls -1 "$CAPTURE_DIR" | LC_ALL=C /usr/bin/sort)
	_count=0
	# shellcheck disable=SC2086 # one name per line, globbing is off
	for _name in $_names; do
		_count=$((_count + 1))
	done
	# shellcheck disable=SC2086 # one name per line, globbing is off
	for _name in $_names; do
		[ "$_count" -ge "$KEEP_PHASES" ] || break
		case "$_name" in
		[0-9]*T[0-9]*Z-*) /bin/rm -rf "${CAPTURE_DIR:?}/$_name" ;;
		*) fail 78 "unexpected entry in $CAPTURE_DIR: $_name" ;;
		esac
		_count=$((_count - 1))
	done
	set +f
	_kb=$(/usr/bin/du -sk "$CAPTURE_DIR")
	_kb=${_kb%%[!0-9]*}
	[ $((_kb * 1024 + PHASE_CAP_BYTES)) -le "$CAPTURE_DIR_CAP_BYTES" ] ||
		fail 75 "$CAPTURE_DIR is too full for another phase"
}

note() {
	echo "$1" >>"$PHASE_DIR/status"
}

# Records a change under run/ before it is made: the record holds the phase
# (or the value pev-leak-recover needs to undo it).
record() {
	echo "$2" >"$RUN_DIR/$1"
}

wait_for_listening() {
	_i=0
	while [ "$_i" -lt "$READY_WAIT" ]; do
		checkpoint
		alive "$2" || return 1
		if /usr/bin/grep -q 'listening on' "$1" 2>/dev/null; then
			return 0
		fi
		/bin/sleep 1
		_i=$((_i + 1))
	done
	return 1
}

resolver_active() {
	_dns=$(/usr/sbin/scutil --dns 2>/dev/null) || return 1
	printf '%s\n' "$_dns" | /usr/bin/grep -Eq '^[[:space:]]*domain[[:space:]]*: test$' || return 1
	printf '%s\n' "$_dns" | /usr/bin/grep -Eq "^[[:space:]]*port[[:space:]]*: $STUB_PORT\$"
}

wait_for_resolver() {
	_i=0
	while [ "$_i" -lt "$READY_WAIT" ]; do
		checkpoint
		if resolver_active; then
			return 0
		fi
		/bin/sleep 1
		_i=$((_i + 1))
	done
	return 1
}

alias_present() {
	/sbin/ifconfig lo0 | /usr/bin/grep -Fq "$FAMILY $TEST_ADDRESS "
}

expected_rules() {
	if [ "$CONSENT" = 1 ]; then echo 3; else echo 2; fi
}

# Sends process $1 SIGTERM, and SIGKILL if it is still there 5 seconds later.
# Fails if it is still there 5 seconds after that. Sets KILLED to 1 when
# SIGKILL was needed.
# shellcheck disable=SC2317 # called from cleanup, which the EXIT trap runs
end_process() {
	KILLED=0
	kill -TERM "$1" 2>/dev/null
	_i=0
	while alive "$1" && [ "$_i" -lt 5 ]; do
		/bin/sleep 1
		_i=$((_i + 1))
	done
	if alive "$1"; then
		KILLED=1
		kill -KILL "$1" 2>/dev/null
		_i=0
		while alive "$1" && [ "$_i" -lt 5 ]; do
			/bin/sleep 1
			_i=$((_i + 1))
		done
	fi
	! alive "$1"
}

# Prints the pid of every root tcpdump that writes into the phase directory,
# recorded or not. Fails if the process list can't be read.
# shellcheck disable=SC2317 # called from cleanup, which the EXIT trap runs
phase_tcpdumps() {
	[ -n "$PHASE_DIR" ] || return 0
	_list=$(/bin/ps -axww -o pid=,uid=,command=) || return 1
	printf '%s\n' "$_list" | while read -r _pid _uid _command; do
		[ "$_uid" = "$ROOT_UID" ] || continue
		case "$_command" in
		*"/usr/sbin/tcpdump "*" -w $PHASE_DIR/"*) echo "$_pid" ;;
		esac
	done
}

# Stops one tcpdump and checks how it ended: a clean exit, and statistics
# with no packets dropped. Adds a reason to the phase when not. Waits at
# most 10 seconds, and fails if the process is still there.
# shellcheck disable=SC2317 # called from cleanup, which the EXIT trap runs
stop_capture() {
	_pid=$1
	_log=$2
	_name=$3
	if ! end_process "$_pid"; then
		RESULT=invalid
		add_reason "the $_name capture did not stop"
		return 1
	fi
	_status=0
	wait "$_pid" 2>/dev/null || _status=$?
	if [ "$KILLED" = 1 ] || [ "$_status" != 0 ]; then
		RESULT=invalid
		add_reason "the $_name capture did not stop cleanly"
	fi
	_dropped=$(/usr/bin/sed -n 's/^\([0-9][0-9]*\) packets\{0,1\} dropped by kernel$/\1/p' "$_log" 2>/dev/null)
	if [ -z "$_dropped" ]; then
		RESULT=invalid
		add_reason "the $_name capture reported no statistics"
	elif [ "$_dropped" != 0 ]; then
		RESULT=invalid
		add_reason "the $_name capture dropped $_dropped packets"
	fi
	# tcpdump prints this line only when the interface dropped packets.
	_dropped=$(/usr/bin/sed -n 's/^\([0-9][0-9]*\) packets\{0,1\} dropped by interface$/\1/p' "$_log" 2>/dev/null)
	if [ -n "$_dropped" ] && [ "$_dropped" != 0 ]; then
		RESULT=invalid
		add_reason "the $_name interface dropped $_dropped packets"
	fi
	return 0
}

# --- Checks that change nothing ------------------------------------------

require_root_owned "${BASE_DIR%/*/*}" d
require_root_owned "${BASE_DIR%/*}" d
require_root_owned "$BASE_DIR" d
require_root_owned "$CAPTURE_DIR" d
require_root_owned "$RUN_DIR" d
if [ -e "$RESOLVER_DIR" ]; then
	require_root_owned "$RESOLVER_DIR" d
fi
/usr/bin/id -u "$LEAK_USER" >/dev/null 2>&1 || fail 78 "no user $LEAK_USER"

# The lock is built as lock.<pid>/lock with the pid inside, then moved into
# run/. The move is a rename, which fails while a lock holds anything, so a
# lock always names its holder.
LOCK_DIR=$RUN_DIR/lock
NEW_LOCK=$RUN_DIR/lock.$$
/bin/rm -rf "$NEW_LOCK"
/bin/mkdir -m 0755 "$NEW_LOCK" "$NEW_LOCK/lock"
echo "$$" >"$NEW_LOCK/lock/pid"
if ! /bin/mv -f "$NEW_LOCK/lock" "$RUN_DIR/" 2>/dev/null; then
	/bin/rm -rf "$NEW_LOCK"
	_holder=$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)
	case "$_holder" in
	'' | *[!0-9]*) fail 75 'a stopped capture or recovery left its lock behind; run pev-leak-recover' ;;
	esac
	if holder_alive "$_holder"; then
		fail 75 "another capture or a recovery is running (pid $_holder)"
	fi
	fail 75 'a stopped capture left its lock behind; run pev-leak-recover'
fi
/bin/rmdir "$NEW_LOCK"

# Records left by an earlier phase mean its changes may still be in place.
for _record in phase-dir anchor pf-token pf-token.out alias tcpdump-pids \
	created-pflog0 created-resolver-dir created-resolver-file; do
	if [ -e "$RUN_DIR/$_record" ] || [ -L "$RUN_DIR/$_record" ]; then
		/bin/rm -rf "$LOCK_DIR"
		fail 75 "an earlier phase left $RUN_DIR/$_record; run pev-leak-recover"
	fi
done

# Everything below is undone by cleanup(), which reverts only what this run
# changed.
READY=0
STOP=''
STARTED=$(/bin/date +%s)
PHASE_DIR=''
PHASE_ID=''
PF_TOKEN=''
PF_PENDING=0
ANCHOR_LOADED=0
MADE_PFLOG=0
MADE_RESOLVER_DIR=0
MADE_RESOLVER=0
MADE_ALIAS=0
PFLOG_PID=''
STUB_PID=''
# While SETTING_UP is 1, a signal is only noted in SIGNALLED.
SETTING_UP=1
SIGNALLED=''

# shellcheck disable=SC2317 # runs from the EXIT trap
cleanup() {
	_rc=$?
	trap '' INT TERM HUP
	trap - EXIT
	set +e
	_errors=''

	# A stop request completes the phase only within its limits and with both
	# captures still running.
	if [ -z "$RESULT" ] && [ "$STOP" = TERM ]; then
		if [ $(($(/bin/date +%s) - STARTED)) -ge "$MAX_SECONDS" ]; then
			add_reason 'time limit reached'
		elif [ "$(pcap_bytes)" -ge "$PHASE_CAP_BYTES" ]; then
			add_reason 'capture size limit reached'
		elif ! alive "$PFLOG_PID" || ! alive "$STUB_PID"; then
			add_reason 'a capture stopped before the end of the phase'
		else
			RESULT=complete
		fi
	fi
	if [ -z "$RESULT" ]; then
		RESULT=invalid
		[ -n "$REASON" ] || REASON="stopped with exit status $_rc"
	fi

	# The block stays until the test user runs nothing, or its traffic would
	# leave unlogged once the anchor is gone.
	_keep=0
	if [ "$ANCHOR_LOADED" = 1 ]; then
		_left=$(leak_processes)
		if [ -n "$_left" ]; then
			printf '%s\n' "$_left" >>"$PHASE_DIR/leftovers"
			if ! only_system_agents "$_left"; then
				RESULT=invalid
				add_reason "$LEAK_USER ran processes other than system agents at teardown"
			fi
			if ! end_leak_processes; then
				_keep=1
				RESULT=invalid
				add_reason "$LEAK_USER processes survived; the block stays until pev-leak-recover"
			fi
		fi
	fi

	_stopped=1
	if [ -n "$PFLOG_PID" ]; then
		stop_capture "$PFLOG_PID" "$PHASE_DIR/pflog0.log" pflog0 || _stopped=0
	fi
	if [ -n "$STUB_PID" ]; then
		stop_capture "$STUB_PID" "$PHASE_DIR/stub.log" lo0 || _stopped=0
	fi
	# Any other root tcpdump that writes into the phase directory is stopped
	# too, and makes the phase invalid.
	if _others=$(phase_tcpdumps); then
		set -f
		# shellcheck disable=SC2086 # one pid per line, globbing is off
		set -- $_others
		set +f
		for _pid do
			if [ "$_pid" = "$PFLOG_PID" ] || [ "$_pid" = "$STUB_PID" ]; then
				continue
			fi
			RESULT=invalid
			add_reason "an unrecorded capture (pid $_pid) was running"
			end_process "$_pid" || _stopped=0
		done
	else
		_stopped=0
		RESULT=invalid
		add_reason 'the process list could not be read'
	fi
	if [ "$_stopped" = 1 ]; then
		/bin/rm -f "$RUN_DIR/tcpdump-pids"
	else
		_errors="$_errors tcpdump"
	fi

	if [ "$_keep" = 1 ]; then
		_errors="$_errors test-user-processes"
	else
		if [ "$ANCHOR_LOADED" = 1 ]; then
			if /sbin/pfctl -a "$ANCHOR" -F rules >/dev/null 2>&1; then
				/bin/rm -f "$RUN_DIR/anchor"
			else
				_errors="$_errors anchor"
			fi
		fi
		if [ -n "$PF_TOKEN" ]; then
			if /sbin/pfctl -X "$PF_TOKEN" >/dev/null 2>&1; then
				/bin/rm -f "$RUN_DIR/pf-token"
			else
				_errors="$_errors pf-token"
			fi
		elif [ "$PF_PENDING" = 1 ]; then
			# pfctl -E succeeded without printing a token: its reference is
			# left to pev-leak-recover, which reports it.
			_errors="$_errors pf-token"
		fi
		if [ "$MADE_ALIAS" = 1 ]; then
			if /sbin/ifconfig lo0 "$FAMILY" "$TEST_ADDRESS" -alias; then
				/bin/rm -f "$RUN_DIR/alias"
			else
				_errors="$_errors alias"
			fi
		fi
		if [ "$MADE_RESOLVER" = 1 ]; then
			if /bin/rm -f "$RESOLVER_FILE"; then
				/bin/rm -f "$RUN_DIR/created-resolver-file"
			else
				_errors="$_errors resolver-file"
			fi
		fi
		if [ "$MADE_RESOLVER_DIR" = 1 ]; then
			/bin/rmdir "$RESOLVER_DIR" 2>/dev/null
			if [ -d "$RESOLVER_DIR" ] && [ -z "$(/bin/ls -A "$RESOLVER_DIR")" ]; then
				_errors="$_errors resolver-dir"
			else
				/bin/rm -f "$RUN_DIR/created-resolver-dir"
			fi
		fi
		if [ "$MADE_PFLOG" = 1 ]; then
			if /sbin/ifconfig pflog0 destroy; then
				/bin/rm -f "$RUN_DIR/created-pflog0"
			else
				_errors="$_errors pflog0"
			fi
		fi
	fi

	# A phase whose cleanup failed is never complete.
	if [ -n "$_errors" ]; then
		RESULT=invalid
		add_reason "cleanup failed:$_errors"
	fi

	if [ -n "$PHASE_DIR" ] && [ -d "$PHASE_DIR" ]; then
		note "result=$RESULT"
		[ -z "$REASON" ] || note "reason=$REASON"
		if [ -z "$_errors" ]; then note cleanup=ok; else note "cleanup=failed:$_errors"; fi
		note "ended=$(stamp)"
		/bin/chmod 0644 "$PHASE_DIR"/* 2>/dev/null
	fi

	if [ -n "$_errors" ]; then
		echo "pev-leak-capture: cleanup left:$_errors; run pev-leak-recover" >&2
	else
		if [ -n "$PHASE_DIR" ]; then
			/bin/rm -f "$RUN_DIR/phase-dir"
		fi
		/bin/rm -rf "$LOCK_DIR"
	fi
	echo "pev-leak-capture: $RESULT${REASON:+ ($REASON)}"
	if [ "$RESULT" = complete ] && [ -z "$_errors" ]; then
		exit 0
	fi
	[ "$_rc" -ne 0 ] || _rc=1
	exit "$_rc"
}

# During setup a signal is only noted; checkpoint acts on it once the change
# in progress and its record are both in place.
# shellcheck disable=SC2317 # runs from the signal traps
on_signal() {
	if [ "$SETTING_UP" = 1 ]; then
		[ -n "$SIGNALLED" ] || SIGNALLED=$1
		return 0
	fi
	if [ -z "$RESULT" ]; then
		if [ "$1" = TERM ] && [ "$READY" = 1 ]; then
			STOP=TERM
		else
			RESULT=invalid
			REASON="SIG$1 before the phase completed"
		fi
	fi
	exit 1
}

checkpoint() {
	if [ -n "$SIGNALLED" ]; then
		SETTING_UP=0
		on_signal "$SIGNALLED"
	fi
}

trap cleanup EXIT
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP

if [ "$CONSENT" = 1 ]; then
	read_test_address
fi
if [ -e "$RESOLVER_FILE" ] || [ -L "$RESOLVER_FILE" ]; then
	fail 75 "$RESOLVER_FILE exists; remove it or run pev-leak-recover"
fi
BEFORE=$(leak_processes)
if [ -n "$BEFORE" ] && ! only_system_agents "$BEFORE"; then
	fail 75 "$LEAK_USER is running processes; a phase starts with none"
fi
if [ "$CONSENT" = 1 ] && /sbin/ifconfig -a | /usr/bin/grep -Fq "$FAMILY $TEST_ADDRESS "; then
	fail 75 "$TEST_ADDRESS is already configured on an interface"
fi
if ! /sbin/pfctl -s rules 2>/dev/null | /usr/bin/grep -Fqx 'anchor "com.apple/*" all'; then
	fail 78 'the main pf ruleset does not evaluate the com.apple/* anchors'
fi

prune_captures
checkpoint
PHASE_ID=$(/bin/date -u +%Y%m%dT%H%M%SZ)-$PHASE-$$
PHASE_DIR=$CAPTURE_DIR/$PHASE_ID
/bin/mkdir -m 0755 "$PHASE_DIR"
record phase-dir "$PHASE_DIR"
note "phase=$PHASE"
note "started=$(stamp)"
STARTED=$(/bin/date +%s)
checkpoint

# System agents from an earlier launch end before the phase starts.
if [ -n "$BEFORE" ]; then
	printf '%s\n' "$BEFORE" >>"$PHASE_DIR/ended-before-start"
	end_leak_processes || fail 75 "$LEAK_USER system agents did not end"
fi
checkpoint

# --- Changes, each recorded under run/ for pev-leak-recover ----------------

# The record names the phase before pf holds a reference; pfctl writes its
# token to pf-token.out, which outlives this shell.
record pf-token "$PHASE_ID"
PF_PENDING=1
_status=0
/sbin/pfctl -E >"$RUN_DIR/pf-token.out" 2>&1 || _status=$?
PF_TOKEN=$(/usr/bin/sed -n 's/^Token *: *\([0-9][0-9]*\) *$/\1/p' "$RUN_DIR/pf-token.out")
case "$PF_TOKEN" in
*[!0-9]*) PF_TOKEN='' ;;
esac
if [ -n "$PF_TOKEN" ]; then
	record pf-token "$PHASE_ID $PF_TOKEN"
	PF_PENDING=0
	/bin/rm -f "$RUN_DIR/pf-token.out"
	[ "$_status" = 0 ] || fail 1 "pfctl -E exited with status $_status"
elif [ "$_status" -ne 0 ] && [ "$_status" -le 128 ]; then
	# pfctl -E failed, so pf holds no reference for it.
	_out=$(/bin/cat "$RUN_DIR/pf-token.out")
	/bin/rm -f "$RUN_DIR/pf-token" "$RUN_DIR/pf-token.out"
	PF_PENDING=0
	fail 1 "pfctl -E failed: $_out"
else
	fail 1 'pfctl -E printed no token'
fi
checkpoint

RULES="block out log quick proto { tcp udp } from any to any user $LEAK_USER"
if [ "$CONSENT" = 1 ]; then
	RULES="pass out log quick $FAMILY proto tcp from any to $TEST_ADDRESS port 80 user $LEAK_USER
$RULES"
fi
record anchor "$PHASE_ID"
ANCHOR_LOADED=1
if ! printf '%s\n' "$RULES" | /sbin/pfctl -a "$ANCHOR" -f - 2>>"$PHASE_DIR/pfctl.log"; then
	fail 1 'loading the anchor failed'
fi
_loaded=$(/sbin/pfctl -a "$ANCHOR" -s rules 2>>"$PHASE_DIR/pfctl.log" | /usr/bin/grep -c ' user = ' || true)
if [ "$_loaded" != "$(expected_rules)" ]; then
	fail 1 "the anchor holds $_loaded rules, expected $(expected_rules)"
fi
checkpoint

if ! /sbin/ifconfig pflog0 >/dev/null 2>&1; then
	record created-pflog0 "$PHASE_ID"
	MADE_PFLOG=1
	/sbin/ifconfig pflog0 create
fi
checkpoint

if [ ! -d "$RESOLVER_DIR" ]; then
	record created-resolver-dir "$PHASE_ID"
	MADE_RESOLVER_DIR=1
	/bin/mkdir -m 0755 "$RESOLVER_DIR"
fi
record created-resolver-file "$PHASE_ID"
if (
	set -C
	printf 'nameserver 127.0.0.1\nport %s\n' "$STUB_PORT" >"$RESOLVER_FILE"
); then
	MADE_RESOLVER=1
else
	/bin/rm -f "$RUN_DIR/created-resolver-file"
	fail 75 "$RESOLVER_FILE appeared while the phase was starting"
fi
checkpoint

if [ "$CONSENT" = 1 ]; then
	record alias "$PHASE_ID $TEST_ADDRESS"
	MADE_ALIAS=1
	if [ "$FAMILY" = inet ]; then
		/sbin/ifconfig lo0 inet "$TEST_ADDRESS" netmask 255.255.255.255 alias
	else
		/sbin/ifconfig lo0 inet6 "$TEST_ADDRESS" prefixlen 128 alias
	fi
fi
checkpoint

# Until the pids are recorded, the record names only the phase; cleanup and
# pev-leak-recover find the captures by the phase directory they write into.
record tcpdump-pids "$PHASE_ID"
/usr/sbin/tcpdump -n -p -U -s "$SNAPLEN" -c "$MAX_PACKETS" -i pflog0 \
	-w "$PHASE_DIR/pflog0.pcap" "ruleset $ANCHOR_NAME" 2>"$PHASE_DIR/pflog0.log" &
PFLOG_PID=$!
/usr/sbin/tcpdump -n -p -U -s "$SNAPLEN" -c "$MAX_PACKETS" -i lo0 \
	-w "$PHASE_DIR/stub.pcap" "port $STUB_PORT" 2>"$PHASE_DIR/stub.log" &
STUB_PID=$!
record tcpdump-pids "$PHASE_ID $PFLOG_PID $STUB_PID"
checkpoint

# --- Readiness --------------------------------------------------------------

if ! /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q '^Status: Enabled'; then
	fail 1 'pf is not enabled'
fi
wait_for_listening "$PHASE_DIR/pflog0.log" "$PFLOG_PID" || fail 1 'the pflog0 capture did not start'
wait_for_listening "$PHASE_DIR/stub.log" "$STUB_PID" || fail 1 'the lo0 capture did not start'
wait_for_resolver || fail 1 'the .test resolver did not become active'
if [ "$CONSENT" = 1 ] && ! alias_present; then
	fail 1 'the test address is not on lo0'
fi

# From here a signal acts at once; one noted during setup acts now.
SETTING_UP=0
checkpoint
READY=1
note "ready=$(stamp)"
echo "pev-leak-capture: ready $PHASE_DIR"

# --- Running ----------------------------------------------------------------

while :; do
	if [ $(($(/bin/date +%s) - STARTED)) -ge "$MAX_SECONDS" ]; then
		REASON='time limit reached'
		break
	fi
	if [ "$(pcap_bytes)" -ge "$PHASE_CAP_BYTES" ]; then
		REASON='capture size limit reached'
		break
	fi
	if ! alive "$PFLOG_PID" || ! alive "$STUB_PID"; then
		REASON='a capture stopped (packet limit, or an error in its log)'
		break
	fi
	/bin/sleep 1
done
RESULT=invalid
exit 1
