// SPDX-License-Identifier: AGPL-3.0-or-later
// The leak-harness shell scripts in tools/leak/, run unprivileged. The
// argument checks run on the scripts as they are. The full flows run on copies
// whose tool and directory paths point at stand-in tools and a temporary
// tree, so no test touches pf, network interfaces, DNS settings or another
// user.

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, testDir } from '../paths';

const TOOLS = join(REPO_ROOT, 'tools', 'leak');
const CAPTURE = join(TOOLS, 'pev-leak-capture.sh');
const RUN = join(TOOLS, 'pev-leak-run.sh');
const RECOVER = join(TOOLS, 'pev-leak-recover.sh');
const DIGEST = join(TOOLS, 'pev-leak-digest.sh');
const UID = process.getuid?.() ?? -1;
const IS_ROOT = UID === 0;
const RESOLVER_TEXT = 'nameserver 127.0.0.1\nport 5354\n';
// Test-user processes as ps lists them: pid, parent pid, executable.
const SYSTEM_AGENTS =
  '4100 1 /usr/libexec/secinitd\n' +
  '4101 1 /usr/sbin/distnoted\n' +
  '4102 1 /System/Library/Frameworks/Security.framework/Versions/A/Resources/trustd\n';
const APP_EXE = '/opt/stage/standard.app/Contents/MacOS/Test App';

function sh(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('/bin/sh', [script, ...args], { encoding: 'utf8', env, timeout: 60_000 });
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('argument checks, on the scripts as they are', () => {
  it.each([[[]], [['']], [['x']], [['Controls']], [['zero;id']], [['../zero']], [['zero', '']]])(
    'pev-leak-capture refuses %j before anything else',
    (args) => {
      const run = sh(CAPTURE, args);
      expect(run.status).toBe(64);
      expect(run.stderr).toBe('usage: pev-leak-capture controls|zero|consent\n');
      expect(run.stdout).toBe('');
    },
  );

  it.each(['controls', 'zero', 'consent'])(
    'pev-leak-capture accepts %s, then needs root',
    (phase) => {
      if (IS_ROOT) return;
      const run = sh(CAPTURE, [phase]);
      expect(run.status).toBe(77);
      expect(run.stderr).toBe('pev-leak-capture: must run as root, through sudo\n');
    },
  );

  it('pev-leak-run works only under its four installed names, with no arguments', () => {
    const dir = testDir('launcher-args');
    expect(sh(RUN).status).toBe(64);
    for (const name of ['standard', 'mas', 'probe', 'consent']) {
      const installed = join(dir, `pev-leak-run-${name}`);
      copyFileSync(RUN, installed);
      for (const args of [['x'], [''], ['--pev-leak'], ['a', 'b']]) {
        const run = sh(installed, args);
        expect(run.status).toBe(64);
        expect(run.stderr).toBe(`usage: pev-leak-run-${name} (no arguments)\n`);
      }
      const run = sh(installed);
      expect(run.status).toBe(77);
      expect(run.stderr).toBe(`pev-leak-run-${name}: must run as pevleak, through sudo\n`);
    }
    copyFileSync(RUN, join(dir, 'pev-leak-run-other'));
    expect(sh(join(dir, 'pev-leak-run-other')).status).toBe(64);
  });

  it('pev-leak-recover takes no arguments and needs root', () => {
    expect(sh(RECOVER, ['x']).status).toBe(64);
    if (!IS_ROOT) expect(sh(RECOVER).status).toBe(77);
  });

  it('pev-leak-digest.sh takes exactly one existing path', () => {
    expect(sh(DIGEST).status).toBe(64);
    expect(sh(DIGEST, ['a', 'b']).status).toBe(64);
    expect(sh(DIGEST, [join(testDir('digest-missing'), 'missing')]).status).toBe(66);
  });
});

describe('digest', () => {
  function digestFunction(path: string): string {
    const text = read(path);
    const start = text.indexOf('\ndigest() {\n');
    return text.slice(start, text.indexOf('\n}\n', start) + 3);
  }

  it('is the same function in pev-leak-run.sh and pev-leak-digest.sh', () => {
    expect(digestFunction(RUN).length).toBeGreaterThan(100);
    expect(digestFunction(RUN)).toBe(digestFunction(DIGEST));
  });

  it('hashes a file like shasum and a tree by content, paths and link targets', () => {
    const dir = testDir('digest');
    const tree = join(dir, 'App Copy.app');
    mkdirSync(join(tree, 'Contents', 'Mac OS'), { recursive: true });
    writeFileSync(join(tree, 'Contents', 'Mac OS', 'Test App'), 'binary\n');
    writeFileSync(join(tree, 'Contents', 'Info.plist'), 'plist\n');
    symlinkSync('Mac OS/Test App', join(tree, 'Contents', 'link'));
    const digest = () => {
      const run = sh(DIGEST, [tree]);
      expect(run.status).toBe(0);
      return run.stdout;
    };

    const file = sh(DIGEST, [join(tree, 'Contents', 'Info.plist')]);
    expect(file.stdout).toBe(
      `${spawnSync('/usr/bin/shasum', ['-a', '256'], { input: 'plist\n', encoding: 'utf8' }).stdout.slice(0, 64)}\n`,
    );

    const first = digest();
    expect(first).toMatch(/^[0-9a-f]{64}\n$/);
    expect(digest()).toBe(first);
    const copy = join(dir, 'copy.app');
    expect(spawnSync('/bin/cp', ['-R', tree, copy]).status).toBe(0);
    expect(sh(DIGEST, [copy]).stdout).toBe(first);

    writeFileSync(join(tree, 'Contents', 'Info.plist'), 'plist!\n');
    const changedContent = digest();
    expect(changedContent).not.toBe(first);
    spawnSync('/bin/rm', [join(tree, 'Contents', 'link')]);
    symlinkSync('Info.plist', join(tree, 'Contents', 'link'));
    expect(digest()).not.toBe(changedContent);
  });
});

// --- Stand-in system -----------------------------------------------------

const REAL_PATHS = [
  '/usr/local/',
  '/etc/resolver',
  '/sbin/pfctl',
  '/sbin/ifconfig',
  '/usr/sbin/tcpdump',
  '/usr/sbin/scutil',
  '/usr/bin/id',
  '/bin/ps',
  '/usr/bin/pkill',
  '/usr/libexec/PlistBuddy',
  '/opt/homebrew/bin/node',
];

const started: number[] = [];
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

// macOS scans every new executable the first time it runs, which costs about
// 0.1 s, so the stand-in tools are written once per file. They find the
// current test's tree and state through PEV_MOCK_ROOT and PEV_MOCK_STATE.
function mockTools(): Record<string, string> {
  return {
    pfctl: `#!/bin/sh
S="$PEV_MOCK_STATE"
echo "pfctl $*" >>"$S/calls"
case "$*" in
-E)
	if [ -e "$S/pfctl-E-fails" ]; then echo 'pfctl: failed' >&2; exit 1; fi
	echo 'pf enabled' >&2
	echo 'Token : 4242' >&2
	: >"$S/pf-enabled" ;;
'-X 4242') rm -f "$S/pf-enabled"; echo 'pf disabled' >&2 ;;
-X*) echo 'pfctl: invalid token' >&2; exit 1 ;;
'-s References') if [ -e "$S/pf-enabled" ]; then echo 'PID      Process Name   TOKEN      TIMESTAMP'; echo '123      capture        4242       1'; fi ;;
'-s info') if [ -e "$S/pf-enabled" ]; then echo 'Status: Enabled for 0 days 00:00:01'; else echo 'Status: Disabled'; fi ;;
'-s rules') [ -e "$S/no-apple-anchor" ] || echo 'anchor "com.apple/*" all' ;;
'-a com.apple/pev-leak -f -') cat >"$S/anchor" ;;
'-a com.apple/pev-leak -s rules')
	[ -f "$S/anchor" ] || exit 0
	while IFS= read -r line; do
		case "$line" in
		*'{ tcp udp }'*)
			echo 'block drop out log quick proto tcp all user = 599'
			echo 'block drop out log quick proto udp all user = 599' ;;
		*) echo "$line" | sed 's/user pevleak/user = 599/' ;;
		esac
	done <"$S/anchor" ;;
'-a com.apple/pev-leak -F rules') rm -f "$S/anchor" ;;
*) echo "unexpected: pfctl $*" >&2; exit 2 ;;
esac
`,
    ifconfig: `#!/bin/sh
S="$PEV_MOCK_STATE"
echo "ifconfig $*" >>"$S/calls"
case "$*" in
pflog0) [ -e "$S/pflog0" ] || { echo 'ifconfig: interface pflog0 does not exist' >&2; exit 1; } ;;
'pflog0 create') : >"$S/pflog0" ;;
'pflog0 destroy') rm "$S/pflog0" ;;
'lo0 inet '*' netmask 255.255.255.255 alias') echo "inet $3" >"$S/alias" ;;
'lo0 inet6 '*' prefixlen 128 alias') echo "inet6 $3" >"$S/alias" ;;
'lo0 inet '*' -alias' | 'lo0 inet6 '*' -alias')
	[ ! -e "$S/alias-remove-fails" ] || exit 1
	[ "$(cat "$S/alias")" = "$2 $3" ] && rm "$S/alias" ;;
lo0 | -a)
	echo 'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384'
	printf '\\tinet 127.0.0.1 netmask 0xff000000\\n'
	if [ -f "$S/alias" ]; then printf '\\t%s netmask 0xffffffff\\n' "$(cat "$S/alias")"; fi
	if [ "$1" = -a ] && [ -f "$S/elsewhere" ]; then printf 'en0: flags=8863<UP>\\n\\t%s prefixlen 64\\n' "$(cat "$S/elsewhere")"; fi ;;
*) echo "unexpected: ifconfig $*" >&2; exit 2 ;;
esac
`,
    tcpdump: `#!/bin/sh
S="$PEV_MOCK_STATE"
echo "tcpdump $*" >>"$S/calls"
echo "$$" >>"$S/tcpdump-pids"
out=''; iface=''; prev=''
for a do
	case "$prev" in -w) out=$a ;; -i) iface=$a ;; esac
	prev=$a
done
stats() {
	[ ! -e "$S/tcpdump-no-stats" ] || exit 0
	echo '7 packets captured' >&2
	echo '7 packets received by filter' >&2
	echo "$(cat "$S/drops-$iface" 2>/dev/null || echo 0) packets dropped by kernel" >&2
	exit 0
}
trap stats TERM
printf '0123456789abcdef01234567' >"$out"
if [ -e "$S/tcpdump-fails-$iface" ]; then echo 'tcpdump: syntax error' >&2; exit 1; fi
echo "tcpdump: listening on $iface, link-type NULL, snapshot length 1024 bytes" >&2
while :; do
	if [ -e "$S/tcpdump-grows" ]; then head -c 4096 /dev/zero >>"$out"; fi
	if [ -e "$S/tcpdump-stops" ]; then exit 0; fi
	sleep 0.1
done
`,
    scutil: `#!/bin/sh
echo "scutil $*" >>"$PEV_MOCK_STATE/calls"
[ "$*" = --dns ] || exit 1
echo 'DNS configuration'
if [ -f "$PEV_MOCK_ROOT/etc/resolver/test" ]; then
	printf '\\nresolver #9\\n  domain   : test\\n  nameserver[0] : 127.0.0.1\\n  port     : 5354\\n'
fi
`,
    id: `#!/bin/sh
S="$PEV_MOCK_STATE"
case "$*" in
-u) echo '${UID}' ;;
'-u pevleak') [ ! -e "$S/no-user" ] || exit 1; echo 599 ;;
-un) if [ -f "$S/whoami" ]; then cat "$S/whoami"; else echo pevleak; fi ;;
*) exit 1 ;;
esac
`,
    // The test user's processes come from the leak-procs file; anything else
    // goes to the real ps.
    ps: `#!/bin/sh
if [ "$*" = '-U pevleak -o pid=,ppid=,comm=' ]; then
	echo "ps $*" >>"$PEV_MOCK_STATE/calls"
	[ -s "$PEV_MOCK_STATE/leak-procs" ] || exit 1
	cat "$PEV_MOCK_STATE/leak-procs"
	exit 0
fi
exec /bin/ps "$@"
`,
    pkill: `#!/bin/sh
echo "pkill $*" >>"$PEV_MOCK_STATE/calls"
[ -e "$PEV_MOCK_STATE/survivors" ] || rm -f "$PEV_MOCK_STATE/leak-procs"
`,
    PlistBuddy: `#!/bin/sh
if [ -f "$PEV_MOCK_STATE/executable" ]; then cat "$PEV_MOCK_STATE/executable"; else echo 'Test App'; fi
`,
  };
}

let sharedBin: string | undefined;
function mockBin(): string {
  if (sharedBin === undefined) {
    const bin = testDir('mock-bin');
    for (const [tool, body] of Object.entries(mockTools())) {
      writeFileSync(join(bin, tool), body, { mode: 0o755 });
    }
    sharedBin = bin;
  }
  return sharedBin;
}

class FakeSystem {
  readonly root: string;
  readonly state: string;
  readonly bin: string;
  readonly base: string;
  readonly captures: string;
  readonly runDir: string;
  readonly stage: string;
  readonly results: string;
  readonly home: string;
  readonly resolver: string;
  readonly config: string;

  constructor(name: string) {
    this.root = testDir(name);
    this.state = join(this.root, 'mock-state');
    this.bin = mockBin();
    this.base = join(this.root, 'usr', 'local', 'var', 'pev-leak');
    this.captures = join(this.base, 'captures');
    this.runDir = join(this.base, 'run');
    this.stage = join(this.base, 'stage');
    this.results = join(this.base, 'results');
    this.home = join(this.base, 'home');
    this.resolver = join(this.root, 'etc', 'resolver', 'test');
    this.config = join(this.root, 'usr', 'local', 'etc', 'pev-leak', 'test-address');
    const dirs = [
      this.state,
      join(this.root, 'libexec'),
      join(this.root, 'etc'),
      join(this.root, 'usr'),
      join(this.root, 'usr', 'local'),
      join(this.root, 'usr', 'local', 'var'),
      join(this.root, 'usr', 'local', 'etc'),
      join(this.root, 'usr', 'local', 'etc', 'pev-leak'),
      this.base,
      this.captures,
      this.runDir,
      this.stage,
      join(this.stage, 'input'),
      this.results,
      this.home,
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
    }
  }

  get env(): NodeJS.ProcessEnv {
    return { ...process.env, PEV_MOCK_ROOT: this.root, PEV_MOCK_STATE: this.state };
  }

  sh(script: string, args: string[] = []) {
    return sh(script, args, this.env);
  }

  start(script: string, args: string[] = []): Running {
    return start(script, args, this.env);
  }

  /** Installs a copy of a script that uses the stand-ins, under `name`. */
  install(source: string, name: string, overrides: Record<string, string> = {}): string {
    let text = read(source);
    const swaps: [string, string][] = [
      ['/usr/local/', `${this.root}/usr/local/`],
      ['/etc/resolver', `${this.root}/etc/resolver`],
      ['/sbin/pfctl', `${this.bin}/pfctl`],
      ['/sbin/ifconfig', `${this.bin}/ifconfig`],
      ['/usr/sbin/tcpdump', `${this.bin}/tcpdump`],
      ['/usr/sbin/scutil', `${this.bin}/scutil`],
      ['/usr/bin/id', `${this.bin}/id`],
      ['/bin/ps', `${this.bin}/ps`],
      ['/usr/bin/pkill', `${this.bin}/pkill`],
      ['/usr/libexec/PlistBuddy', `${this.bin}/PlistBuddy`],
      ['/opt/homebrew/bin/node', process.execPath],
      ['ROOT_UID=0', `ROOT_UID=${UID}`],
      ['/bin/sleep 1', '/bin/sleep 0.1'],
    ];
    for (const [from, to] of [...swaps, ...Object.entries(overrides)]) {
      if (!text.includes(from) && from in overrides) throw new Error(`not in ${name}: ${from}`);
      text = text.split(from).join(to);
    }
    // Every remaining system path must now sit under the temporary root.
    for (const real of REAL_PATHS) {
      if (real === process.execPath) continue;
      for (let at = text.indexOf(real); at !== -1; at = text.indexOf(real, at + 1)) {
        expect(text.slice(Math.max(0, at - this.root.length), at)).toBe(this.root);
      }
    }
    const path = join(this.root, 'libexec', name);
    writeFileSync(path, text, { mode: 0o755 });
    return path;
  }

  has(name: string): boolean {
    return existsSync(join(this.state, name));
  }

  set(name: string, content = ''): void {
    writeFileSync(join(this.state, name), content);
  }

  calls(): string[] {
    const file = join(this.state, 'calls');
    return existsSync(file) ? read(file).trim().split('\n') : [];
  }

  setAddress(address: string): void {
    writeFileSync(this.config, address);
    chmodSync(this.config, 0o644);
  }
}

interface Running {
  pid: number;
  out: () => string;
  err: () => string;
  exited: Promise<number | null>;
  waitFor: (text: string) => Promise<void>;
  signal: (name: NodeJS.Signals) => void;
}

function start(script: string, args: string[] = [], env = process.env): Running {
  const child = spawn('/bin/sh', [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
  if (child.pid !== undefined) started.push(child.pid);
  let stdout = '';
  let stderr = '';
  let done = false;
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      done = true;
      resolve(code);
    }),
  );
  return {
    pid: child.pid ?? -1,
    out: () => stdout,
    err: () => stderr,
    exited,
    signal: (name) => child.kill(name),
    async waitFor(text) {
      const until = Date.now() + 20_000;
      while (!stdout.includes(text)) {
        if (done || Date.now() > until) {
          throw new Error(`no "${text}"\nstdout: ${stdout}\nstderr: ${stderr}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

function alive(pid: number): boolean {
  const ps = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && !ps.stdout.includes('Z');
}

function phaseDir(out: string): string {
  const match = /ready (\S+)\n/.exec(out);
  if (!match?.[1]) throw new Error(`no phase directory in: ${out}`);
  return match[1];
}

function status(dir: string): Record<string, string> {
  return Object.fromEntries(
    read(join(dir, 'status'))
      .trim()
      .split('\n')
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}

/** Asserts that the fake system is back to its state before the capture. */
function expectRestored(fake: FakeSystem): void {
  expect(existsSync(fake.resolver)).toBe(false);
  expect(existsSync(join(fake.root, 'etc', 'resolver'))).toBe(false);
  expect(fake.has('anchor')).toBe(false);
  expect(fake.has('pf-enabled')).toBe(false);
  expect(fake.has('pflog0')).toBe(false);
  expect(fake.has('alias')).toBe(false);
  expect(readdirSync(fake.runDir)).toEqual([]);
  const pids = fake.has('tcpdump-pids') ? read(join(fake.state, 'tcpdump-pids')).split(/\s+/) : [];
  for (const pid of pids.filter(Boolean)) expect(alive(Number(pid))).toBe(false);
}

// --- pev-leak-capture ----------------------------------------------------

describe('pev-leak-capture', () => {
  it('sets up a zero phase, reports ready, and undoes everything on SIGTERM', async () => {
    const fake = new FakeSystem('capture-zero');
    // 20 older phases: only the newest 14 stay, plus the new one.
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(fake.captures, `20200101T0000${String(i).padStart(2, '0')}Z-zero-1`));
    }
    const script = fake.install(CAPTURE, 'pev-leak-capture');
    const run = fake.start(script, ['zero']);
    await run.waitFor('pev-leak-capture: ready ');
    const dir = phaseDir(run.out());

    expect(read(fake.resolver)).toBe(RESOLVER_TEXT);
    expect(read(join(fake.state, 'anchor'))).toBe(
      'block out log quick proto { tcp udp } from any to any user pevleak\n',
    );
    expect(fake.has('pf-enabled')).toBe(true);
    expect(fake.has('pflog0')).toBe(true);
    expect(read(join(fake.runDir, 'pf-token'))).toBe('4242\n');
    expect(read(join(fake.runDir, 'lock', 'pid'))).toBe(`${run.pid}\n`);
    expect(read(join(fake.runDir, 'phase-dir'))).toBe(`${dir}\n`);
    // Each change is recorded with the phase it belongs to.
    const phaseId = `${dir.split('/').at(-1)}\n`;
    for (const record of [
      'anchor',
      'created-pflog0',
      'created-resolver-dir',
      'created-resolver-file',
    ]) {
      expect(read(join(fake.runDir, record)), record).toBe(phaseId);
    }
    const tcpdumps = fake.calls().filter((c) => c.startsWith('tcpdump '));
    // The two captures start in parallel, so their calls may come in either order.
    expect(tcpdumps.sort()).toEqual(
      [
        `tcpdump -n -p -U -s 1024 -c 2000 -i pflog0 -w ${dir}/pflog0.pcap ruleset pev-leak`,
        `tcpdump -n -p -U -s 1024 -c 2000 -i lo0 -w ${dir}/stub.pcap port 5354`,
      ].sort(),
    );
    expect(status(dir)).toMatchObject({ phase: 'zero' });
    expect(status(dir).ready).toMatch(/Z$/);

    run.signal('SIGTERM');
    expect(await run.exited).toBe(0);
    expect(run.out()).toMatch(/pev-leak-capture: complete\n$/);
    expect(status(dir)).toMatchObject({ result: 'complete', cleanup: 'ok' });
    expectRestored(fake);
    const calls = fake.calls();
    expect(calls).toContain('pfctl -a com.apple/pev-leak -F rules');
    expect(calls).toContain('pfctl -X 4242');
    expect(calls).toContain('ifconfig pflog0 destroy');
    expect(
      calls.indexOf('ps -U pevleak -o pid=,ppid=,comm=', calls.indexOf('pfctl -E')),
    ).toBeLessThan(calls.indexOf('pfctl -a com.apple/pev-leak -F rules'));
    expect(existsSync(join(dir, 'leftovers'))).toBe(false);
    expect(read(join(dir, 'pflog0.log'))).toContain('0 packets dropped by kernel');
    for (const name of ['pflog0.pcap', 'stub.pcap', 'status']) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o644);
    }
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    const kept = readdirSync(fake.captures).sort();
    expect(kept).toHaveLength(15);
    expect(kept[0]).toBe('20200101T000006Z-zero-1');
  });

  it('keeps an existing pflog0 and /etc/resolver', async () => {
    const fake = new FakeSystem('capture-existing');
    fake.set('pflog0');
    mkdirSync(join(fake.root, 'etc', 'resolver'), { mode: 0o755 });
    chmodSync(join(fake.root, 'etc', 'resolver'), 0o755);
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['controls']);
    await run.waitFor('ready');
    run.signal('SIGTERM');
    expect(await run.exited).toBe(0);
    expect(fake.has('pflog0')).toBe(true);
    expect(fake.calls()).not.toContain('ifconfig pflog0 destroy');
    expect(existsSync(join(fake.root, 'etc', 'resolver'))).toBe(true);
    expect(existsSync(fake.resolver)).toBe(false);
  });

  it.each([
    ['100.128.0.1', 'inet'],
    ['2a00::1', 'inet6'],
  ])('consent with %s passes only port 80 to it and adds it to lo0', async (address, family) => {
    const fake = new FakeSystem('capture-consent');
    fake.setAddress(`${address}\n`);
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['consent']);
    await run.waitFor('ready');
    expect(read(join(fake.state, 'anchor'))).toBe(
      `pass out log quick ${family} proto tcp from any to ${address} port 80 user pevleak\n` +
        'block out log quick proto { tcp udp } from any to any user pevleak\n',
    );
    expect(read(join(fake.state, 'alias'))).toBe(`${family} ${address}\n`);
    expect(read(join(fake.runDir, 'alias'))).toBe(`${address}\n`);
    run.signal('SIGTERM');
    expect(await run.exited).toBe(0);
    expect(fake.calls()).toContain(`ifconfig lo0 ${family} ${address} -alias`);
    expectRestored(fake);
  });

  const accepted = [
    '1.1.1.1',
    '11.0.0.1',
    '100.128.0.1',
    '172.32.0.1',
    '192.0.3.1',
    '198.20.0.1',
    '223.255.255.254',
    '2a00::1',
    '2001:200::1',
    '2001:dba::1',
    '2600:1f18:abcd::5',
    '3ffe::1',
    '2a00:1:2:3:4:5:6:7',
  ];
  const refused = [
    '',
    '192.0.2.5',
    '198.51.100.1',
    '203.0.113.7',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.1.2.3',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.0.8',
    '192.88.99.1',
    '01.2.3.4',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.1.1.1/32',
    '2001:db8::1',
    '2001::1',
    '2001:1ff::1',
    '2002::1',
    '3fff::1',
    '3fff:fff::1',
    'fe80::1',
    'fc00::1',
    '::1',
    '::',
    'ff02::1',
    '2A00::1',
    '2a00:01::1',
    '2a00::1::2',
    '2a00::1%lo0',
    '2a00:1:2:3:4:5:6:7:8',
    '1.1.1.1\n1.1.1.2',
    '1.1.1.1 ',
    ' 1.1.1.1',
  ];

  // The script's own address checks, run once over every case.
  it('accepts only global unicast addresses as the test address', () => {
    const text = read(CAPTURE);
    const body = (name: string) => {
      const at = text.indexOf(`\n${name}() {\n`);
      expect(at).toBeGreaterThan(-1);
      return text.slice(at, text.indexOf('\n}\n', at) + 3);
    };
    const cases = [...accepted, ...refused];
    const harness = `${body('valid_ipv4')}${body('valid_ipv6')}
for a do
	if valid_ipv4 "$a" || valid_ipv6 "$a"; then echo "accept $FAMILY"; else echo refuse; fi
	FAMILY=none
done
`;
    const run = spawnSync('/bin/sh', ['-c', `set -eu\nFAMILY=none\n${harness}`, 'sh', ...cases], {
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    const verdicts = run.stdout.trim().split('\n');
    expect(Object.fromEntries(cases.map((c, i) => [c, verdicts[i]]))).toEqual(
      Object.fromEntries([
        ...accepted.map((c) => [c, `accept ${c.includes(':') ? 'inet6' : 'inet'}`]),
        ...refused.map((c) => [c, 'refuse']),
      ]),
    );
  });

  // With the com.apple anchor missing, the capture stops after it has read
  // the address, so the message tells which check stopped it.
  it.each(['100.128.0.1', '2a00::1'])('reads the test address %j from its file', (address) => {
    const fake = new FakeSystem('capture-address');
    fake.setAddress(`${address}\n`);
    fake.set('no-apple-anchor');
    const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['consent']);
    expect(run.stderr).toContain('does not evaluate the com.apple/* anchors');
    expect(run.status).toBe(78);
  });

  it.each(['192.0.2.5', '1.1.1.1\n1.1.1.2', ' 1.1.1.1', '2a00::1 # comment', ''])(
    'refuses the test-address file %j and changes nothing',
    (address) => {
      const fake = new FakeSystem('capture-address');
      fake.setAddress(`${address}\n`);
      const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['consent']);
      expect(run.status).toBe(78);
      expect(run.stderr).toMatch(/not a (single|global unicast) IP address/);
      expect(fake.calls().filter((c) => c.startsWith('pfctl') || c.startsWith('ifconfig'))).toEqual(
        [],
      );
      expect(readdirSync(fake.runDir)).toEqual([]);
      expect(readdirSync(fake.captures)).toEqual([]);
    },
  );

  it('refuses a test-address file that is group-writable or a symbolic link', () => {
    const fake = new FakeSystem('capture-config');
    fake.setAddress('100.128.0.1\n');
    chmodSync(fake.config, 0o664);
    const script = fake.install(CAPTURE, 'pev-leak-capture');
    expect(fake.sh(script, ['consent']).stderr).toContain('writable by group or others');
    const target = join(fake.root, 'address');
    writeFileSync(target, '100.128.0.1\n');
    spawnSync('/bin/rm', [fake.config]);
    symlinkSync(target, fake.config);
    expect(fake.sh(script, ['consent']).stderr).toContain('not the expected type');
  });

  it('refuses directories that are not root-owned and closed to others', () => {
    const fake = new FakeSystem('capture-dirs');
    chmodSync(fake.captures, 0o777);
    const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    expect(run.status).toBe(78);
    expect(run.stderr).toContain(`writable by group or others: ${fake.captures}`);
    expect(fake.calls()).toEqual([]);
  });

  it('refuses when the test address is already on an interface', () => {
    const fake = new FakeSystem('capture-elsewhere');
    fake.setAddress('100.128.0.1\n');
    fake.set('elsewhere', 'inet 100.128.0.1');
    const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['consent']);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('already configured');
    expect(fake.calls()).not.toContain('pfctl -E');
  });

  it('refuses while /etc/resolver/test exists, and leaves it alone', () => {
    const fake = new FakeSystem('capture-resolver');
    mkdirSync(join(fake.root, 'etc', 'resolver'));
    chmodSync(join(fake.root, 'etc', 'resolver'), 0o755);
    writeFileSync(fake.resolver, 'nameserver 192.0.2.53\n');
    const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('resolver/test exists');
    expect(read(fake.resolver)).toBe('nameserver 192.0.2.53\n');
    expect(fake.calls()).not.toContain('pfctl -E');
    expect(readdirSync(fake.runDir)).toEqual([]);
  });

  it('refuses while the test user runs anything but system agents', () => {
    const fake = new FakeSystem('capture-busy-user');
    fake.set('leak-procs', `${SYSTEM_AGENTS}4000 3999 ${APP_EXE}\n`);
    const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('pevleak is running processes');
    expect(fake.calls()).not.toContain('pfctl -E');
    expect(fake.calls()).not.toContain('pkill -KILL -U pevleak');
  });

  it('ends system agents left from an earlier launch, then starts', async () => {
    const fake = new FakeSystem('capture-agents-before');
    fake.set('leak-procs', SYSTEM_AGENTS);
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    expect(read(join(dir, 'ended-before-start'))).toBe(SYSTEM_AGENTS);
    expect(fake.calls().indexOf('pkill -KILL -U pevleak')).toBeLessThan(
      fake.calls().indexOf('pfctl -E'),
    );
    run.signal('SIGTERM');
    expect(await run.exited).toBe(0);
    expect(status(dir)).toMatchObject({ result: 'complete' });
    expectRestored(fake);
  });

  it('runs one capture at a time, and a stale lock needs recovery', () => {
    const fake = new FakeSystem('capture-lock');
    const script = fake.install(CAPTURE, 'pev-leak-capture');
    mkdirSync(join(fake.runDir, 'lock'));
    writeFileSync(join(fake.runDir, 'lock', 'pid'), `${process.pid}\n`);
    let run = fake.sh(script, ['zero']);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain(`another capture is running (pid ${process.pid})`);

    const gone = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(fake.runDir, 'lock', 'pid'), `${gone}\n`);
    run = fake.sh(script, ['zero']);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('run pev-leak-recover');
    expect(existsSync(join(fake.runDir, 'lock', 'pid'))).toBe(true);
    expect(fake.calls()).not.toContain('pfctl -E');
  });

  it('refuses when the main ruleset skips the com.apple anchors', () => {
    const fake = new FakeSystem('capture-no-anchor');
    fake.set('no-apple-anchor');
    const run = fake.sh(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    expect(run.status).toBe(78);
    expect(fake.calls()).not.toContain('pfctl -E');
    expect(readdirSync(fake.runDir)).toEqual([]);
  });

  it('refuses when the capture directory has no room for another phase', () => {
    const fake = new FakeSystem('capture-full');
    mkdirSync(join(fake.captures, '20200101T000000Z-zero-1'));
    writeFileSync(
      join(fake.captures, '20200101T000000Z-zero-1', 'pflog0.pcap'),
      Buffer.alloc(65536),
    );
    const script = fake.install(CAPTURE, 'pev-leak-capture', {
      'CAPTURE_DIR_CAP_BYTES=104857600': 'CAPTURE_DIR_CAP_BYTES=5300000',
    });
    const run = fake.sh(script, ['zero']);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('too full');
    expect(fake.calls()).not.toContain('pfctl -E');
  });

  async function invalidRun(
    name: string,
    overrides: Record<string, string>,
    afterReady: (fake: FakeSystem) => void,
    reason: string,
  ): Promise<void> {
    const fake = new FakeSystem(name);
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture', overrides), ['zero']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    afterReady(fake);
    const code = await Promise.race([
      run.exited,
      new Promise<'running'>((r) => setTimeout(() => r('running'), 15_000)),
    ]);
    if (code === 'running') {
      run.signal('SIGTERM');
      await run.exited;
    }
    expect(code).toBe(1);
    expect(status(dir)).toMatchObject({ result: 'invalid', cleanup: 'ok' });
    expect(status(dir).reason?.startsWith(reason), status(dir).reason).toBe(true);
    expect(run.out()).toContain(`pev-leak-capture: invalid (${reason}`);
    expectRestored(fake);
  }

  it('marks the phase invalid at the time limit', () =>
    invalidRun(
      'capture-time',
      { 'MAX_SECONDS=900': 'MAX_SECONDS=2' },
      () => {},
      'time limit reached',
    ));

  it('marks the phase invalid at the capture size limit', () =>
    invalidRun(
      'capture-size',
      { 'PHASE_CAP_BYTES=5242880': 'PHASE_CAP_BYTES=65536' },
      (fake) => fake.set('tcpdump-grows'),
      'capture size limit reached',
    ));

  it('marks the phase invalid when a capture stops', () =>
    invalidRun(
      'capture-stopped',
      {},
      (fake) => fake.set('tcpdump-stops'),
      'a capture stopped (packet limit, or an error in its log)',
    ));

  it('ends leftover test-user processes before lifting the block, and marks the phase invalid', async () => {
    const fake = new FakeSystem('capture-leftover');
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    const left = `4000 3999 ${APP_EXE}\n${SYSTEM_AGENTS}`;
    fake.set('leak-procs', left);
    run.signal('SIGTERM');
    expect(await run.exited).toBe(1);
    expect(status(dir)).toMatchObject({
      result: 'invalid',
      reason: 'pevleak ran processes other than system agents at teardown',
    });
    expect(read(join(dir, 'leftovers'))).toBe(left);
    const calls = fake.calls();
    expect(calls.indexOf('pkill -KILL -U pevleak')).toBeGreaterThan(-1);
    expect(calls.indexOf('pkill -KILL -U pevleak')).toBeLessThan(
      calls.indexOf('pfctl -a com.apple/pev-leak -F rules'),
    );
    expectRestored(fake);
  });

  it('lists and ends system agents at teardown without failing the phase', async () => {
    const fake = new FakeSystem('capture-agents-after');
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    fake.set('leak-procs', SYSTEM_AGENTS);
    run.signal('SIGTERM');
    expect(await run.exited).toBe(0);
    expect(status(dir)).toMatchObject({ result: 'complete', cleanup: 'ok' });
    expect(read(join(dir, 'leftovers'))).toBe(SYSTEM_AGENTS);
    expect(fake.calls()).toContain('pkill -KILL -U pevleak');
    expectRestored(fake);
  });

  it('keeps the block, the resolver, the address and the lock when processes survive', async () => {
    const fake = new FakeSystem('capture-survivors');
    fake.setAddress('100.128.0.1\n');
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['consent']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    fake.set('leak-procs', `4000 3999 ${APP_EXE}\n`);
    fake.set('survivors');
    run.signal('SIGTERM');
    expect(await run.exited).toBe(1);
    expect(status(dir)).toMatchObject({
      result: 'invalid',
      cleanup: 'failed: test-user-processes',
    });
    expect(status(dir).reason).toContain('survived; the block stays until pev-leak-recover');
    expect(run.err()).toContain('run pev-leak-recover');
    expect(fake.has('anchor')).toBe(true);
    expect(fake.has('pf-enabled')).toBe(true);
    expect(fake.has('alias')).toBe(true);
    expect(read(fake.resolver)).toBe(RESOLVER_TEXT);
    expect(readdirSync(fake.runDir).sort()).toEqual([
      'alias',
      'anchor',
      'created-pflog0',
      'created-resolver-dir',
      'created-resolver-file',
      'lock',
      'pf-token',
      'phase-dir',
    ]);
    expect(fake.calls()).not.toContain('pfctl -a com.apple/pev-leak -F rules');
    expect(fake.calls()).not.toContain('pfctl -X 4242');

    // Recovery keeps everything while they still run, then finishes the job.
    const recover = fake.install(RECOVER, 'pev-leak-recover');
    let again = fake.sh(recover);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('survived');
    expect(fake.has('anchor')).toBe(true);
    rmSync(join(fake.state, 'survivors'));
    again = fake.sh(recover);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(status(dir).reason).toBe('the capture did not clean up itself');
    expectRestored(fake);
  });

  it('marks the phase invalid when a capture reports dropped packets or no statistics', async () => {
    for (const [state, content, reason] of [
      ['drops-pflog0', '3', 'the pflog0 capture dropped 3 packets'],
      ['tcpdump-no-stats', '', 'the pflog0 capture reported no statistics'],
    ] as const) {
      const fake = new FakeSystem('capture-drops');
      fake.set(state, content);
      const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
      await run.waitFor('ready');
      const dir = phaseDir(run.out());
      run.signal('SIGTERM');
      expect(await run.exited).toBe(1);
      expect(status(dir)).toMatchObject({ result: 'invalid', cleanup: 'ok' });
      expect(status(dir).reason).toContain(reason);
      expectRestored(fake);
    }
  });

  it('checks the captures again when SIGTERM arrives, not only when ready', async () => {
    const fake = new FakeSystem('capture-recheck');
    // The running loop checks every 3 s here, so the stop request comes first.
    const script = fake.install(CAPTURE, 'pev-leak-capture', {
      '\t/bin/sleep 0.1\ndone\nRESULT=invalid': '\t/bin/sleep 3\ndone\nRESULT=invalid',
    });
    const run = fake.start(script, ['zero']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    await new Promise((r) => setTimeout(r, 200));
    fake.set('tcpdump-stops');
    await new Promise((r) => setTimeout(r, 400));
    run.signal('SIGTERM');
    expect(await run.exited).toBe(1);
    expect(status(dir)).toMatchObject({ result: 'invalid' });
    expect(status(dir).reason).toMatch(/^a capture stopped/);
    expectRestored(fake);
  });

  it('marks the phase invalid on SIGINT, and undoes everything', async () => {
    const fake = new FakeSystem('capture-int');
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['controls']);
    await run.waitFor('ready');
    const dir = phaseDir(run.out());
    run.signal('SIGINT');
    expect(await run.exited).toBe(1);
    expect(status(dir)).toMatchObject({
      result: 'invalid',
      reason: 'SIGINT before the phase completed',
    });
    expectRestored(fake);
  });

  it('undoes its changes when a capture fails to start', async () => {
    const fake = new FakeSystem('capture-no-tcpdump');
    fake.set('tcpdump-fails-pflog0');
    const run = fake.start(fake.install(CAPTURE, 'pev-leak-capture'), ['zero']);
    expect(await run.exited).toBe(1);
    expect(run.err()).toContain('the pflog0 capture did not start');
    const [dir] = readdirSync(fake.captures);
    const result = status(join(fake.captures, dir ?? ''));
    expect(result).toMatchObject({ result: 'invalid', cleanup: 'ok' });
    expect(result.reason?.startsWith('the pflog0 capture did not start')).toBe(true);
    expect(run.out()).not.toContain('ready');
    expectRestored(fake);
  });

  it('never uses the tcpdump options that run commands, drop privileges or rotate files', () => {
    const text = read(CAPTURE);
    const lines = text.split('\n').filter((line) => /tcpdump /.test(line) && !/^\s*#/.test(line));
    for (const line of lines) expect(line).not.toMatch(/\s-[zZCG]\b/);
    expect(text).not.toMatch(/pfctl[^\n]*\s-(?:F\s+all|d\b)/);
    expect(text).not.toMatch(/^\s*(?:\.|source)\s/m);
  });
});

// --- pev-leak-recover ----------------------------------------------------

describe('pev-leak-recover', () => {
  function killedCapture(fake: FakeSystem): { dir: string; bystander: number } {
    const dir = join(fake.captures, '20260101T000000Z-zero-1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'status'), 'phase=zero\n');
    const gone = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
    mkdirSync(join(fake.runDir, 'lock'));
    writeFileSync(join(fake.runDir, 'lock', 'pid'), `${gone}\n`);
    writeFileSync(join(fake.runDir, 'pf-token'), '4242\n');
    writeFileSync(join(fake.runDir, 'alias'), '100.128.0.1\n');
    writeFileSync(join(fake.runDir, 'phase-dir'), `${dir}\n`);
    for (const record of [
      'anchor',
      'created-pflog0',
      'created-resolver-dir',
      'created-resolver-file',
    ]) {
      writeFileSync(join(fake.runDir, record), '20260101T000000Z-zero-1\n');
    }
    // A process that is not tcpdump must survive, even if its pid is listed.
    const bystander = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    started.push(bystander.pid ?? -1);
    writeFileSync(join(fake.runDir, 'tcpdump-pids'), `${bystander.pid} 1\n`);
    fake.set('pf-enabled');
    fake.set('pflog0');
    fake.set('anchor', 'block out log quick proto { tcp udp } from any to any user pevleak\n');
    fake.set('alias', 'inet 100.128.0.1');
    fake.set('leak-procs', SYSTEM_AGENTS);
    mkdirSync(join(fake.root, 'etc', 'resolver'));
    chmodSync(join(fake.root, 'etc', 'resolver'), 0o755);
    writeFileSync(fake.resolver, RESOLVER_TEXT);
    return { dir, bystander: bystander.pid ?? -1 };
  }

  it('undoes what a killed capture left behind', () => {
    const fake = new FakeSystem('recover');
    const { dir, bystander } = killedCapture(fake);
    const run = fake.sh(fake.install(RECOVER, 'pev-leak-recover'));
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const calls = fake.calls();
    expect(calls).toContain('pkill -KILL -U pevleak');
    expect(calls.indexOf('pkill -KILL -U pevleak')).toBeLessThan(
      calls.indexOf('pfctl -a com.apple/pev-leak -F rules'),
    );
    expect(calls).toContain('pfctl -X 4242');
    expect(calls).toContain('ifconfig lo0 inet 100.128.0.1 -alias');
    expect(calls).toContain('ifconfig pflog0 destroy');
    expect(status(dir)).toMatchObject({
      result: 'invalid',
      reason: 'the capture did not clean up itself',
    });
    expect(read(join(dir, 'leftovers'))).toBe(SYSTEM_AGENTS);
    expect(alive(bystander)).toBe(true);
    expectRestored(fake);
  });

  it('refuses while a capture is running or still starting', () => {
    const fake = new FakeSystem('recover-running');
    killedCapture(fake);
    const recover = fake.install(RECOVER, 'pev-leak-recover');
    writeFileSync(join(fake.runDir, 'lock', 'pid'), `${process.pid}\n`);
    let run = fake.sh(recover);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('a capture is running');
    rmSync(join(fake.runDir, 'lock', 'pid'));
    run = fake.sh(recover);
    expect(run.status).toBe(75);
    expect(run.stderr).toContain('a capture is starting');
    expect(fake.calls()).toEqual([]);
    expect(existsSync(fake.resolver)).toBe(true);
  });

  it('keeps a record, and the lock, until its change is undone', () => {
    const fake = new FakeSystem('recover-retry');
    killedCapture(fake);
    const recover = fake.install(RECOVER, 'pev-leak-recover');
    fake.set('alias-remove-fails');
    let run = fake.sh(recover);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not recovered: alias');
    expect(read(join(fake.runDir, 'alias'))).toBe('100.128.0.1\n');
    expect(existsSync(join(fake.runDir, 'lock'))).toBe(true);
    expect(existsSync(join(fake.runDir, 'pf-token'))).toBe(false);
    rmSync(join(fake.state, 'alias-remove-fails'));
    run = fake.sh(recover);
    expect(run.status).toBe(0);
    expectRestored(fake);
  });

  it('leaves a resolver file that changed, or that no capture recorded creating', () => {
    const fake = new FakeSystem('recover-foreign');
    killedCapture(fake);
    writeFileSync(fake.resolver, 'nameserver 192.0.2.53\n');
    const recover = fake.install(RECOVER, 'pev-leak-recover');
    let run = fake.sh(recover);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not recovered: resolver-file');
    expect(read(fake.resolver)).toBe('nameserver 192.0.2.53\n');
    expect(existsSync(join(fake.runDir, 'created-resolver-file'))).toBe(true);

    // Without a record, even a file with the capture's content stays.
    rmSync(join(fake.runDir, 'created-resolver-file'));
    // /etc/resolver wasn't empty, so the first run left it and dropped its record.
    expect(existsSync(join(fake.runDir, 'created-resolver-dir'))).toBe(false);
    writeFileSync(fake.resolver, RESOLVER_TEXT);
    run = fake.sh(recover);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('no capture recorded creating it');
    expect(read(fake.resolver)).toBe(RESOLVER_TEXT);
  });

  it('leaves records of another phase alone', () => {
    const fake = new FakeSystem('recover-scope');
    killedCapture(fake);
    writeFileSync(join(fake.runDir, 'created-pflog0'), '20250101T000000Z-zero-9\n');
    const run = fake.sh(fake.install(RECOVER, 'pev-leak-recover'));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('not recovered: created-pflog0');
    expect(fake.has('pflog0')).toBe(true);
    expect(fake.calls()).not.toContain('ifconfig pflog0 destroy');
  });

  it('drops a pf token that pf no longer holds, as after a restart', () => {
    const fake = new FakeSystem('recover-stale-token');
    killedCapture(fake);
    rmSync(join(fake.state, 'pf-enabled'));
    const run = fake.sh(fake.install(RECOVER, 'pev-leak-recover'));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('no longer held');
    expect(fake.calls()).not.toContain('pfctl -X 4242');
    expectRestored(fake);
  });

  it('has nothing to do on a clean system', () => {
    const fake = new FakeSystem('recover-clean');
    const run = fake.sh(fake.install(RECOVER, 'pev-leak-recover'));
    expect(run.status).toBe(0);
    expect(fake.calls()).toEqual([
      'ps -U pevleak -o pid=,ppid=,comm=',
      'pfctl -a com.apple/pev-leak -F rules',
    ]);
    expect(readdirSync(fake.runDir)).toEqual([]);
  });
});

// --- pev-leak-run --------------------------------------------------------

describe('pev-leak-run', () => {
  const ECHO_ENV = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
console.log(JSON.stringify({ input: Buffer.concat(chunks).toString('utf8'), env: process.env, argv: process.argv.slice(2), cwd: process.cwd() }));
`;

  function launch(fake: FakeSystem, target: string, overrides: Record<string, string> = {}) {
    const script = fake.install(RUN, `pev-leak-run-${target}`, overrides);
    const run = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: { ...fake.env, LEAK_TEST_MARKER: 'parent' },
      timeout: 60_000,
    });
    const match = /results (\S+)\n/.exec(run.stdout);
    const out = match?.[1] ?? '';
    const launchTxt =
      out && existsSync(join(out, 'launch.txt')) ? read(join(out, 'launch.txt')) : '';
    const fields = Object.fromEntries(
      launchTxt
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { run, out, fields };
  }

  function app(fake: FakeSystem, target: string): string {
    const bundle = join(fake.stage, `${target}.app`);
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), '<plist/>\n');
    const exe = join(bundle, 'Contents', 'MacOS', 'Test App');
    writeFileSync(
      exe,
      `#!/bin/sh\nprintf 'arg=%s\\n' "$@"\nprintf 'input=%s\\n' "$(cat)"\nenv | sort\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(fake.stage, 'input', `${target}.json`), '{"nonce":"abc"}\n');
    return bundle;
  }

  it('runs the probe script with a fixed environment, its input on stdin, and records it', () => {
    const fake = new FakeSystem('run-probe');
    writeFileSync(join(fake.stage, 'probe.mjs'), ECHO_ENV);
    writeFileSync(join(fake.stage, 'input', 'probe.json'), '{"mode":"marker","position":"pre"}\n');
    const { run, out, fields } = launch(fake, 'probe');
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/pev-leak-run-probe: exit 0\n$/);
    expect(out.startsWith(`${fake.results}/`)).toBe(true);
    const seen = JSON.parse(read(join(out, 'stdout.txt')));
    expect(seen.input).toBe('{"mode":"marker","position":"pre"}\n');
    expect(seen.argv).toEqual([]);
    // macOS's CoreFoundation adds __CF_USER_TEXT_ENCODING inside the process.
    const names = Object.keys(seen.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING');
    expect(names.sort()).toEqual(['HOME', 'LOGNAME', 'PATH', 'TMPDIR', 'USER']);
    expect(seen.env).toMatchObject({
      HOME: fake.home,
      TMPDIR: `${fake.home}/tmp/`,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      USER: 'pevleak',
      LOGNAME: 'pevleak',
    });
    expect(fields).toMatchObject({
      launcher: 'pev-leak-run-probe',
      user: 'pevleak',
      program: join(fake.stage, 'probe.mjs'),
      program_digest: sh(DIGEST, [join(fake.stage, 'probe.mjs')]).stdout.trim(),
      input_digest: sh(DIGEST, [join(fake.stage, 'input', 'probe.json')]).stdout.trim(),
      node: process.execPath,
      node_digest: sh(DIGEST, [process.execPath]).stdout.trim(),
      exit: '0',
    });
    expect(statSync(out).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, 'stdout.txt')).mode & 0o777).toBe(0o644);
  });

  it('starts the standard build with --pev-leak and an empty user data directory', () => {
    const fake = new FakeSystem('run-standard');
    const bundle = app(fake, 'standard');
    const stale = join(fake.home, 'state', 'standard', 'stale');
    mkdirSync(stale, { recursive: true });
    const { run, out, fields } = launch(fake, 'standard');
    expect(run.status).toBe(0);
    const stdout = read(join(out, 'stdout.txt'));
    expect(stdout).toContain(
      `arg=--pev-leak\narg=--pev-user-data=${fake.home}/state/standard\ninput={"nonce":"abc"}\n`,
    );
    expect(stdout).not.toContain('LEAK_TEST_MARKER');
    expect(existsSync(stale)).toBe(false);
    expect(fields.program_digest).toBe(sh(DIGEST, [bundle]).stdout.trim());
    expect(fields.program).toBe(bundle);
  });

  it('starts the Mac App Store build with --pev-leak only', () => {
    const fake = new FakeSystem('run-mas');
    app(fake, 'mas');
    const { run, out } = launch(fake, 'mas');
    expect(run.status).toBe(0);
    expect(read(join(out, 'stdout.txt'))).toMatch(/^arg=--pev-leak\ninput=/);
  });

  it('stops the program at the time limit and leaves nothing running', () => {
    const fake = new FakeSystem('run-timeout');
    writeFileSync(join(fake.stage, 'probe.mjs'), 'setInterval(() => {}, 1000);\n');
    writeFileSync(join(fake.stage, 'input', 'probe.json'), '{}\n');
    const { run, fields } = launch(fake, 'probe', { 'MAX_SECONDS=600': 'MAX_SECONDS=1' });
    expect(run.status).toBe(75);
    expect(run.stdout).toMatch(/invalid \(time limit reached\)\n$/);
    expect(fields.invalid).toBe('time limit reached');
    const left = spawnSync('/usr/bin/pgrep', ['-f', join(fake.stage, 'probe.mjs')]);
    expect(left.status).toBe(1);
  });

  // 2 MiB for results and the home together, with 512 KiB kept free.
  const SMALL_LIMIT = {
    'TRANSIENT_CAP_KB=40960': 'TRANSIENT_CAP_KB=2048',
    'HEADROOM_KB=16384': 'HEADROOM_KB=512',
  };

  it('stops a program that fills the home past the size limit', () => {
    const fake = new FakeSystem('run-size');
    writeFileSync(
      join(fake.stage, 'probe.mjs'),
      `import { writeFileSync } from 'node:fs';
for (let i = 0; i < 4; i++) writeFileSync(\`\${process.env.TMPDIR}/fill-\${i}\`, Buffer.alloc(1024 * 1024));
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(join(fake.stage, 'input', 'probe.json'), '{}\n');
    const { run, fields } = launch(fake, 'probe', SMALL_LIMIT);
    expect(run.status).toBe(75);
    expect(fields.invalid).toMatch(/^size limit reached \(\d+ KiB\)$/);
    const left = spawnSync('/usr/bin/pgrep', ['-f', join(fake.stage, 'probe.mjs')]);
    expect(left.status).toBe(1);
  });

  it('refuses to launch when the home leaves no room under the size limit', () => {
    const fake = new FakeSystem('run-full');
    writeFileSync(join(fake.stage, 'probe.mjs'), '');
    writeFileSync(join(fake.stage, 'input', 'probe.json'), '{}\n');
    writeFileSync(join(fake.home, 'big'), Buffer.alloc(1800 * 1024));
    const { run } = launch(fake, 'probe', SMALL_LIMIT);
    expect(run.status).toBe(75);
    expect(run.stderr).toMatch(/a launch needs them under 1536 KiB/);
    expect(readdirSync(fake.results)).toEqual([]);
  });

  it('passes SIGTERM on to the program', async () => {
    const fake = new FakeSystem('run-term');
    writeFileSync(
      join(fake.stage, 'probe.mjs'),
      `process.on('SIGTERM', () => { console.log('term'); process.exit(0); });\nconsole.log('started');\nsetInterval(() => {}, 1000);\n`,
    );
    writeFileSync(join(fake.stage, 'input', 'probe.json'), '{}\n');
    const running = fake.start(fake.install(RUN, 'pev-leak-run-probe'));
    await running.waitFor('results ');
    const out = /results (\S+)\n/.exec(running.out())?.[1] ?? '';
    const until = Date.now() + 15_000;
    while (!(
      existsSync(join(out, 'stdout.txt')) && read(join(out, 'stdout.txt')).includes('started')
    )) {
      if (Date.now() > until) throw new Error('program did not start');
      await new Promise((r) => setTimeout(r, 25));
    }
    running.signal('SIGTERM');
    expect(await running.exited).toBe(0);
    expect(read(join(out, 'stdout.txt'))).toBe('started\nterm\n');
    expect(read(join(out, 'launch.txt'))).toContain('\nexit=0\n');
  });

  it('keeps the newest result directories only', () => {
    const fake = new FakeSystem('run-prune');
    for (let i = 0; i < 70; i++) {
      mkdirSync(join(fake.results, `20200101T0000${String(i).padStart(2, '0')}Z-probe-1`));
    }
    writeFileSync(join(fake.stage, 'probe.mjs'), '');
    writeFileSync(join(fake.stage, 'input', 'probe.json'), '{}\n');
    const { run } = launch(fake, 'probe');
    expect(run.status).toBe(0);
    const kept = readdirSync(fake.results).sort();
    expect(kept).toHaveLength(60);
    expect(kept[0]).toBe('20200101T000011Z-probe-1');
  });

  it('refuses a missing or oversized input, a linked program and an odd executable name', () => {
    const fake = new FakeSystem('run-refuse');
    writeFileSync(join(fake.stage, 'probe.mjs'), '');
    expect(launch(fake, 'probe').run.status).toBe(66);
    writeFileSync(join(fake.stage, 'input', 'probe.json'), Buffer.alloc(65537));
    expect(launch(fake, 'probe').run.status).toBe(65);

    app(fake, 'mas');
    fake.set('executable', '../../../bin/sh');
    expect(launch(fake, 'mas').run.status).toBe(65);
    fake.set('executable', '.hidden');
    expect(launch(fake, 'mas').run.status).toBe(65);

    const consent = join(fake.stage, 'consent.mjs');
    writeFileSync(join(fake.root, 'elsewhere.mjs'), '');
    symlinkSync(join(fake.root, 'elsewhere.mjs'), consent);
    writeFileSync(join(fake.stage, 'input', 'consent.json'), '{}\n');
    expect(launch(fake, 'consent').run.status).toBe(66);
    expect(readdirSync(fake.results)).toEqual([]);
  });
});
