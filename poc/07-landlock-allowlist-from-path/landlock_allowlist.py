#!/usr/bin/env python3
"""PATH から Landlock 許可リストを動的に組む案の検証（PoC）。

poc/00-prior-2026-08-30/landlock2.py と同じ手法（ctypes 直叩き）。
Landlock は一度掛けると外せないので、実験ごとに子プロセスを起こす。

使い方:
    python3 landlock_allowlist.py            # 全実験を順に走らせる
    python3 landlock_allowlist.py <mode>     # 単一実験（内部用）
"""
import ctypes
import os
import shutil
import subprocess
import sys
import tempfile

libc = ctypes.CDLL(None, use_errno=True)
NR_CREATE, NR_ADD, NR_RESTRICT, PR_NNP = 444, 445, 446, 38
LANDLOCK_CREATE_RULESET_VERSION = 1 << 0

EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1 << 0, 1 << 1, 1 << 2, 1 << 3
RX = EXECUTE | READ_FILE | READ_DIR      # 実行＋読み取り
RO = READ_FILE | READ_DIR                # 読み取りのみ
FS_ALL = (1 << 15) - 1                   # ABI 3 までの全権限（＝読み書き作成削除）


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def abi_version() -> int:
    v = libc.syscall(NR_CREATE, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
    if v < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset(VERSION)")
    return v


# --------------------------------------------------------------------------
# 許可リストの組み立て
# --------------------------------------------------------------------------

def path_dirs() -> list[str]:
    """process.env.PATH 相当（Python では os.environ['PATH']）を分解する。"""
    out, seen = [], set()
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue                       # 空要素は「カレントディレクトリ」の意味。採らない
        entry = os.path.abspath(entry)
        if entry not in seen:
            seen.add(entry)
            out.append(entry)
    return out


def library_dirs() -> list[str]:
    """動的リンカが見るディレクトリを /etc/ld.so.conf* から読む。"""
    dirs, seen = [], set()

    def add(d: str) -> None:
        d = os.path.abspath(d)
        if d not in seen:
            seen.add(d)
            dirs.append(d)

    # 設定に書かれていなくても常に見られる既定の探索先
    for d in ("/lib", "/lib64", "/usr/lib", "/usr/lib64"):
        add(d)

    def parse(conf: str) -> None:
        try:
            with open(conf) as f:
                lines = f.read().splitlines()
        except OSError:
            return
        for line in lines:
            line = line.split("#")[0].strip()
            if not line:
                continue
            if line.startswith("include "):
                import glob
                for sub in sorted(glob.glob(line[len("include "):].strip())):
                    parse(sub)
            else:
                add(line)

    parse("/etc/ld.so.conf")
    return dirs


def build_allowlist(project_root: str, extra_path_dirs: list[str] | None = None):
    """PATH 由来の動的許可リスト。(パス, 権限) の列を返す。"""
    rules: list[tuple[str, int]] = []
    for d in path_dirs() + (extra_path_dirs or []):
        rules.append((d, RX))
    for d in library_dirs():
        rules.append((d, RX))              # .so は mmap(PROT_EXEC) されるので実行も要る
    for d in ("/etc", "/proc"):
        rules.append((d, RX))
    # /dev は読むだけでは足りない。git が /dev/null を O_RDWR で開くため書き込みが要る
    rules.append(("/dev", RX | WRITE_FILE))
    rules.append((project_root, FS_ALL))   # Project の根だけ読み書き
    return rules


def resolved_target_dirs(dirs: list[str]) -> list[str]:
    """PATH 内の実行ファイルが symlink のとき、その実体があるディレクトリを足す案。

    /usr/local/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js のように、
    PATH のディレクトリを許可しただけでは実体に届かないケースがあるため。
    """
    out, seen = [], set()
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if not os.path.islink(p):
                continue
            real = os.path.realpath(p)
            # symlink がディレクトリを指すこともある（/usr/bin/X11 -> /usr/bin）。
            # そこで dirname を取ると /usr 全体を許してしまう——実際に踏んだ
            target = real if os.path.isdir(real) else os.path.dirname(real)
            if target and target not in seen and os.path.isdir(target):
                seen.add(target)
                out.append(target)
    return out


FIXED_ALLOWLIST_DIRS =["/usr", "/lib", "/lib64", "/bin", "/etc", "/proc"]


def build_fixed_allowlist(project_root: str):
    """landlock2.py の固定リスト（比較用）。/dev の書き込みだけは揃えてある。"""
    return ([(d, RX) for d in FIXED_ALLOWLIST_DIRS]
            + [("/dev", RX | WRITE_FILE), (project_root, FS_ALL)])


# --------------------------------------------------------------------------
# 適用
# --------------------------------------------------------------------------

def restrict(rules, verbose=True):
    attr = RulesetAttr(FS_ALL)
    fd = libc.syscall(NR_CREATE, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset")
    added, missing = [], []
    for path, acc in rules:
        if not os.path.isdir(path):
            missing.append(path)           # 握りつぶさず記録する（規則2）
            continue
        pfd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        pb = PathBeneath(acc, pfd)
        if libc.syscall(NR_ADD, fd, 1, ctypes.byref(pb), 0) < 0:
            raise OSError(ctypes.get_errno(), "landlock_add_rule " + path)
        os.close(pfd)
        added.append((path, acc))
    if libc.prctl(PR_NNP, 1, 0, 0, 0) < 0:
        raise OSError(ctypes.get_errno(), "PR_SET_NO_NEW_PRIVS")
    if libc.syscall(NR_RESTRICT, fd, 0) < 0:
        raise OSError(ctypes.get_errno(), "landlock_restrict_self")
    os.close(fd)
    if verbose:
        for p, a in added:
            print(f"    許可 {p}  (0x{a:04x})")
        for p in missing:
            print(f"    不在なので追加せず {p}")


# --------------------------------------------------------------------------
# 観測
# --------------------------------------------------------------------------

def run(cmd) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        return f"起動できず({type(e).__name__}: {e})"
    if r.returncode != 0:
        return f"失敗(rc={r.returncode}) {(r.stderr or r.stdout).strip().splitlines()[:1]}"
    return "OK: " + (r.stdout or r.stderr).strip().splitlines()[0]


def can_read(path: str) -> str:
    try:
        with open(path, "rb") as f:
            f.read(1)                      # 中身は表示しない
        return "読めた"
    except Exception as e:
        return f"拒否({type(e).__name__})"


def can_write(path: str) -> str:
    try:
        with open(path, "w") as f:
            f.write("x")
        return "書けた"
    except Exception as e:
        return f"拒否({type(e).__name__})"


def report(title: str, items):
    print(f"  -- {title}")
    for label, result in items:
        print(f"     {label:<52} -> {result}")


# --------------------------------------------------------------------------
# 実験本体（子プロセスとして走る）
# --------------------------------------------------------------------------

def probe_tools():
    return [
        ("node --version", run(["node", "--version"])),
        ("npm --version", run(["npm", "--version"])),
        ("git --version", run(["git", "--version"])),
        ("/bin/ls (Project 根)", run(["/bin/ls", os.environ["POC_ROOT"]])),
    ]


def probe_root():
    root = os.environ["POC_ROOT"]
    return [
        (f"読 {root}/in.txt", can_read(f"{root}/in.txt")),
        (f"書 {root}/new.txt", can_write(f"{root}/new.txt")),
    ]


def probe_home():
    home = os.path.expanduser("~")
    items = [
        (f"読 {home}/.claude/.credentials.json", can_read(f"{home}/.claude/.credentials.json")),
        (f"読 {os.environ['POC_HOME_SECRET']}", can_read(os.environ["POC_HOME_SECRET"])),
        (f"読 {home}/.bashrc", can_read(f"{home}/.bashrc")),
        (f"読 {os.environ['POC_OUTSIDE']}", can_read(os.environ["POC_OUTSIDE"])),
    ]
    return items


def child_main(mode: str) -> None:
    root = os.environ["POC_ROOT"]
    fake_bin = os.environ["POC_FAKE_BIN"]

    if mode == "baseline":
        print("  (Landlock なし)")
    elif mode == "fixed":
        restrict(build_fixed_allowlist(root))
    elif mode == "fixed-home":
        os.environ["PATH"] = fake_bin + os.pathsep + os.environ["PATH"]
        restrict(build_fixed_allowlist(root))
    elif mode == "path":
        restrict(build_allowlist(root))
    elif mode == "path-home":
        os.environ["PATH"] = fake_bin + os.pathsep + os.environ["PATH"]
        restrict(build_allowlist(root))
    elif mode == "path-nolocallib":
        rules = [r for r in build_allowlist(root) if r[0] != "/usr/local/lib"]
        restrict(rules)
    elif mode == "path-siblings":
        os.environ["PATH"] = fake_bin + os.pathsep + os.environ["PATH"]
        rules = [r for r in build_allowlist(root) if r[0] != "/usr/local/lib"]
        extra = []
        for d in path_dirs() + [fake_bin]:
            if os.path.basename(d) not in ("bin", "sbin"):
                continue
            prefix = os.path.dirname(d)
            for sib in ("lib", "lib64", "libexec", "share"):
                extra.append((os.path.join(prefix, sib), RX))
        restrict(extra + rules)
    elif mode == "path-prefix":
        os.environ["PATH"] = fake_bin + os.pathsep + os.environ["PATH"]
        rules = [r for r in build_allowlist(root) if r[0] != "/usr/local/lib"]
        # PATH のディレクトリが .../bin なら、その導入先（親）ごと許す
        prefixes = [os.path.dirname(d) for d in path_dirs() + [fake_bin]
                    if os.path.basename(d) in ("bin", "sbin")]
        restrict([(d, RX) for d in prefixes] + rules)
    elif mode == "path-resolved":
        rules = [r for r in build_allowlist(root) if r[0] != "/usr/local/lib"]
        extra = [(d, RX) for d in resolved_target_dirs(path_dirs())]
        restrict(extra + rules)
    else:
        raise SystemExit(f"未知のモード {mode}")

    report("ツール", probe_tools())
    report("Project の根", probe_root())
    report("根の外", probe_home())
    if mode in ("path-home", "fixed-home", "path-prefix", "path-siblings"):
        report("PATH に足したホーム配下ディレクトリ", [
            ("偽 nvm bin の実行ファイル", run([os.path.join(fake_bin, "fakenode")])),
            (f"読 {fake_bin}/.npmrc-with-token", can_read(f"{fake_bin}/.npmrc-with-token")),
            (f"読 {os.path.dirname(fake_bin)}/../lib/secret.txt",
             can_read(os.path.normpath(os.path.join(fake_bin, "..", "lib", "secret.txt")))),
        ])


# --------------------------------------------------------------------------
# 親（段取り）
# --------------------------------------------------------------------------

MODES = [
    ("baseline", "閉じ込め前（対照）"),
    ("fixed", "固定リスト（landlock2.py と同じ /usr,/lib,/lib64,/bin,/etc,/proc,/dev）"),
    ("fixed-home", "固定リスト ＋ PATH にホーム配下（偽 nvm）"),
    ("path", "PATH 由来の動的許可リスト"),
    ("path-nolocallib", "PATH 由来 − /usr/local/lib（npm の JS 本体を落とすとどうなるか）"),
    ("path-resolved", "PATH 由来 − /usr/local/lib ＋ symlink の実体ディレクトリ"),
    ("path-home", "PATH 由来 ＋ PATH にホーム配下（偽 nvm）"),
    ("path-prefix", "PATH の .../bin の親（導入先）ごと許す案 ＋ ホーム配下の偽 nvm"),
    ("path-siblings", "PATH の .../bin の兄弟 lib/libexec/share だけ足す案 ＋ ホーム配下の偽 nvm"),
]


def main() -> None:
    if len(sys.argv) > 1:
        child_main(sys.argv[1])
        return

    print(f"kernel = {os.uname().release}")
    print(f"Landlock ABI = {abi_version()}")
    print(f"PATH = {os.environ.get('PATH')}")
    print(f"PATH 由来のディレクトリ = {path_dirs()}")
    print(f"ld.so.conf 由来のディレクトリ = {library_dirs()}")
    for tool in ("node", "npm", "git"):
        print(f"  which {tool} = {shutil.which(tool)}")

    work = tempfile.mkdtemp(prefix="ll-path-poc-")
    root = os.path.join(work, "project-root")
    outside = os.path.join(work, "outside.txt")
    os.makedirs(root)
    open(os.path.join(root, "in.txt"), "w").write("hello\n")
    open(outside, "w").write("この PoC の作業ディレクトリだが Project の根の外\n")

    # ホーム配下に nvm 風のディレクトリを作り、実行ファイルと機微ファイルを同居させる
    home_sim = os.path.join(os.path.expanduser("~"), ".ll-poc-nvm", "versions", "node", "v99.0.0")
    fake_bin = os.path.join(home_sim, "bin")
    os.makedirs(os.path.join(home_sim, "lib"), exist_ok=True)
    os.makedirs(fake_bin, exist_ok=True)
    fake = os.path.join(fake_bin, "fakenode")
    with open(fake, "w") as f:
        f.write("#!/bin/sh\necho 'fakenode v99.0.0 が動いた'\n")
    os.chmod(fake, 0o755)
    open(os.path.join(fake_bin, ".npmrc-with-token"), "w").write("//registry:_authToken=SECRET\n")
    open(os.path.join(home_sim, "lib", "secret.txt"), "w").write("bin の隣（PATH の外）\n")

    home_secret = os.path.join(os.path.expanduser("~"), ".ll-poc-credentials.json")
    open(home_secret, "w").write('{"token":"DUMMY"}\n')

    env = dict(os.environ)
    env.update(POC_ROOT=root, POC_FAKE_BIN=fake_bin,
               POC_HOME_SECRET=home_secret, POC_OUTSIDE=outside)

    try:
        for mode, title in MODES:
            print(f"\n=== {mode}: {title} ===", flush=True)
            subprocess.run([sys.executable, os.path.abspath(__file__), mode], env=env)
            sys.stdout.flush()
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(os.path.join(os.path.expanduser("~"), ".ll-poc-nvm"), ignore_errors=True)
        os.unlink(home_secret)


if __name__ == "__main__":
    main()
