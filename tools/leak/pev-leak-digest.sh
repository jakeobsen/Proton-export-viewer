#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# pev-leak-digest: prints the digest pev-leak-run records for a staged
# program, so a staged copy can be compared with the build it came from.
#
#   pev-leak-digest.sh <file-or-directory>

set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
IFS=$(printf ' \t\n.')
IFS=${IFS%.}
LC_ALL=C
export LC_ALL

if [ "$#" -ne 1 ]; then
	echo 'usage: pev-leak-digest.sh <file-or-directory>' >&2
	exit 64
fi
if [ ! -e "$1" ]; then
	echo "pev-leak-digest.sh: no such file or directory: $1" >&2
	exit 66
fi

# Prints the SHA-256 of a file, or of a directory tree: the hash of the
# bytewise-sorted list of "<SHA-256>  <path>" for each regular file and
# "link  <path> -> <target>" for each symbolic link, paths relative to the
# tree. pev-leak-run.sh holds the same function and records this digest for
# every program it starts.
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

digest "$1"
