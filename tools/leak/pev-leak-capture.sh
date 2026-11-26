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

# Accepts one IPv6 address in lowercase hex without leading zeros in a group
# (the form ifconfig prints), inside 2000::/3 and outside 2001::/23,
# 2001:db8::/32, 2002::/16 and 3fff::/20. Sets FAMILY to inet6.
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
	valid_ipv4 "$TEST_ADDRESS" || valid_ipv6 "$TEST_ADDRESS" ||
		fail 78 "$CONFIG_FILE: not a global unicast IP address"
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

# Stops one tcpdump and checks how it ended: a clean exit, and statistics
# with no packets dropped. Adds a reason to the phase when not.
stop_capture() {
	_pid=$1
	_log=$2
	_name=$3
	kill -TERM "$_pid" 2>/dev/null
	_i=0
	while alive "$_pid" && [ "$_i" -lt 5 ]; do
		/bin/sleep 1
		_i=$((_i + 1))
	done
	_killed=0
	if alive "$_pid"; then
		kill -KILL "$_pid" 2>/dev/null
		_killed=1
	fi
	_status=0
	wait "$_pid" 2>/dev/null || _status=$?
	if [ "$_killed" = 1 ] || [ "$_status" != 0 ]; then
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

LOCK_DIR=$RUN_DIR/lock
if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
	_holder=$(/bin/cat "$LOCK_DIR/pid" 2>/dev/null || true)
	case "$_holder" in
	'' | *[!0-9]*) fail 75 'another capture is starting, or a stopped one left its lock (then run pev-leak-recover)' ;;
	esac
	if alive "$_holder"; then
		fail 75 "another capture is running (pid $_holder)"
	fi
	fail 75 'a stopped capture left its lock behind; run pev-leak-recover'
fi
echo "$$" >"$LOCK_DIR/pid"

# Everything below is undone by cleanup(), which reverts only what this run
# changed.
READY=0
STOP=''
STARTED=$(/bin/date +%s)
PHASE_DIR=''
PHASE_ID=''
PF_TOKEN=''
ANCHOR_LOADED=0
MADE_PFLOG=0
MADE_RESOLVER_DIR=0
MADE_RESOLVER=0
MADE_ALIAS=0
PFLOG_PID=''
STUB_PID=''

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

	if [ -n "$PFLOG_PID" ]; then
		stop_capture "$PFLOG_PID" "$PHASE_DIR/pflog0.log" pflog0
	fi
	if [ -n "$STUB_PID" ]; then
		stop_capture "$STUB_PID" "$PHASE_DIR/stub.log" lo0
	fi
	/bin/rm -f "$RUN_DIR/tcpdump-pids"

	if [ "$_keep" = 1 ]; then
		_errors=' test-user-processes'
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
		/bin/rm -f "$RUN_DIR/phase-dir"
		/bin/rm -rf "$LOCK_DIR"
	fi
	echo "pev-leak-capture: $RESULT${REASON:+ ($REASON)}"
	if [ "$RESULT" = complete ] && [ -z "$_errors" ]; then
		exit 0
	fi
	[ "$_rc" -ne 0 ] || _rc=1
	exit "$_rc"
}

# shellcheck disable=SC2317 # runs from the signal traps
on_signal() {
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
PHASE_ID=$(/bin/date -u +%Y%m%dT%H%M%SZ)-$PHASE-$$
PHASE_DIR=$CAPTURE_DIR/$PHASE_ID
/bin/mkdir -m 0755 "$PHASE_DIR"
record phase-dir "$PHASE_DIR"
note "phase=$PHASE"
note "started=$(stamp)"
STARTED=$(/bin/date +%s)

# System agents from an earlier launch end before the phase starts.
if [ -n "$BEFORE" ]; then
	printf '%s\n' "$BEFORE" >>"$PHASE_DIR/ended-before-start"
	end_leak_processes || fail 75 "$LEAK_USER system agents did not end"
fi

# --- Changes, each recorded under run/ for pev-leak-recover ----------------

_out=$(/sbin/pfctl -E 2>&1) || fail 1 "pfctl -E failed: $_out"
PF_TOKEN=$(printf '%s\n' "$_out" | /usr/bin/sed -n 's/^Token *: *\([0-9][0-9]*\) *$/\1/p')
case "$PF_TOKEN" in
'' | *[!0-9]*)
	PF_TOKEN=''
	fail 1 'pfctl -E printed no token'
	;;
esac
record pf-token "$PF_TOKEN"

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

if ! /sbin/ifconfig pflog0 >/dev/null 2>&1; then
	record created-pflog0 "$PHASE_ID"
	MADE_PFLOG=1
	/sbin/ifconfig pflog0 create
fi

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

if [ "$CONSENT" = 1 ]; then
	record alias "$TEST_ADDRESS"
	MADE_ALIAS=1
	if [ "$FAMILY" = inet ]; then
		/sbin/ifconfig lo0 inet "$TEST_ADDRESS" netmask 255.255.255.255 alias
	else
		/sbin/ifconfig lo0 inet6 "$TEST_ADDRESS" prefixlen 128 alias
	fi
fi

/usr/sbin/tcpdump -n -p -U -s "$SNAPLEN" -c "$MAX_PACKETS" -i pflog0 \
	-w "$PHASE_DIR/pflog0.pcap" "ruleset $ANCHOR_NAME" 2>"$PHASE_DIR/pflog0.log" &
PFLOG_PID=$!
/usr/sbin/tcpdump -n -p -U -s "$SNAPLEN" -c "$MAX_PACKETS" -i lo0 \
	-w "$PHASE_DIR/stub.pcap" "port $STUB_PORT" 2>"$PHASE_DIR/stub.log" &
STUB_PID=$!
record tcpdump-pids "$PFLOG_PID $STUB_PID"

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
