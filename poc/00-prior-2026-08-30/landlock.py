import ctypes, os, sys, subprocess
libc = ctypes.CDLL(None, use_errno=True)
NR_CREATE, NR_ADD, NR_RESTRICT = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
# ABI1..3 のファイルシステム権限をすべて扱う
FS_ALL = (1<<15) - 1   # 1<<0 .. 1<<14

class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]
class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

def restrict(allow_dir):
    attr = RulesetAttr(FS_ALL)
    fd = libc.syscall(NR_CREATE, ctypes.byref(attr), ctypes.sizeof(attr), 0)
    if fd < 0: raise OSError(ctypes.get_errno(), "create_ruleset")
    pfd = os.open(allow_dir, os.O_PATH | os.O_CLOEXEC)
    pb = PathBeneath(FS_ALL, pfd)
    if libc.syscall(NR_ADD, fd, 1, ctypes.byref(pb), 0) < 0:
        raise OSError(ctypes.get_errno(), "add_rule")
    os.close(pfd)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0:
        raise OSError(ctypes.get_errno(), "no_new_privs")
    if libc.syscall(NR_RESTRICT, fd, 0) < 0:
        raise OSError(ctypes.get_errno(), "restrict_self")
    os.close(fd)

def probe(tag):
    for p in ("/tmp/ll-allowed/in.txt", "/tmp/ll-denied/out.txt", "/etc/passwd"):
        try:
            open(p).read(1); r = "読めた"
        except Exception as e: r = f"拒否({type(e).__name__})"
        print(f"  [{tag}] {p} -> {r}")

if sys.argv[1:] == ["child"]:
    probe("子プロセス"); sys.exit(0)

print("== 閉じ込め前 =="); probe("親")
restrict("/tmp/ll-allowed")
print("== 閉じ込め後（親） =="); probe("親")
print("== 閉じ込め後（execve した子） ==")
subprocess.run([sys.executable, __file__, "child"])
