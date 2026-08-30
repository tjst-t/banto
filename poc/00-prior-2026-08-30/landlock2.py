import ctypes, os, sys, subprocess
libc = ctypes.CDLL(None, use_errno=True)
NR_CREATE, NR_ADD, NR_RESTRICT, PR_NNP = 444, 445, 446, 38
R = (1<<0)|(1<<2)|(1<<3)          # EXECUTE | READ_FILE | READ_DIR
RW = (1<<15)-1                     # 全部（読み書き・作成・削除）
FS_ALL = (1<<15)-1

class A(ctypes.Structure): _fields_=[("handled_access_fs",ctypes.c_uint64)]
class P(ctypes.Structure):
    _pack_=1; _fields_=[("allowed_access",ctypes.c_uint64),("parent_fd",ctypes.c_int32)]

def restrict(rules):
    a=A(FS_ALL); fd=libc.syscall(NR_CREATE, ctypes.byref(a), ctypes.sizeof(a), 0)
    if fd<0: raise OSError(ctypes.get_errno(),"create")
    for path, acc in rules:
        if not os.path.exists(path): continue
        pfd=os.open(path, os.O_PATH|os.O_CLOEXEC)
        pb=P(acc, pfd)
        if libc.syscall(NR_ADD, fd, 1, ctypes.byref(pb), 0)<0: raise OSError(ctypes.get_errno(),"add "+path)
        os.close(pfd)
    if libc.prctl(PR_NNP,1,0,0,0)<0: raise OSError(ctypes.get_errno(),"nnp")
    if libc.syscall(NR_RESTRICT, fd, 0)<0: raise OSError(ctypes.get_errno(),"restrict")
    os.close(fd)

def probe(tag):
    for p,act in (("/tmp/ll-allowed/in.txt","読"),("/tmp/ll-allowed/new.txt","書"),
                  ("/tmp/ll-denied/out.txt","読"),("/etc/passwd","読"),("/home/ubuntu/.claude/.credentials.json","読")):
        try:
            if act=="書": open(p,"w").write("x"); r="書けた"
            else: open(p).read(1); r="読めた"
        except Exception as e: r=f"拒否({type(e).__name__})"
        print(f"  [{tag}] {act} {p} -> {r}")

if sys.argv[1:]==["child"]:
    probe("子(execve 後)"); sys.exit(0)

restrict([("/usr",R),("/lib",R),("/lib64",R),("/bin",R),          ("/etc",R),("/proc",R),("/dev",R),("/tmp/ll-allowed",RW)])
print("== 閉じ込め後（親） =="); probe("親")
print("== 子プロセス（execve をまたぐ） ==")
subprocess.run([sys.executable, __file__, "child"])
print("== shell も試す ==")
print("  ls /tmp/ll-allowed ->", subprocess.run(["/bin/ls","/tmp/ll-allowed"],capture_output=True,text=True).stdout.strip() or "(失敗)")
r=subprocess.run(["/bin/cat","/etc/passwd"],capture_output=True,text=True)
print("  cat /etc/passwd ->", "読めた" if r.returncode==0 else f"拒否(rc={r.returncode})")
