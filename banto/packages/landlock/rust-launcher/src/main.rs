// banto-landlock-exec — 方針を持たない忠実な実行者。
//
// 何を許可するかは一切決めない。TS 側（packages/landlock/src/derive.ts）が
// 計算したルールセットファイルをそのまま実行するだけ。
// docs/specs/v4-security.md「許可リストの組み方」「Project の根は Module
// 起動時に確定させる」を参照。

use landlock::{
    Access, AccessFs, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
    RulesetAttr, RulesetCreatedAttr, RulesetStatus, ABI,
};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};

const REQUIRED_ABI: ABI = ABI::V4;

// exit code は TS 側が原因を文字列パースせずに判別するための唯一の手段
// （規則2：黙って別の経路へ落ちない）。
const EXIT_USAGE: u8 = 64;
const EXIT_BAD_RULESET_FILE: u8 = 65;
const EXIT_ABI_INSUFFICIENT: u8 = 66;
const EXIT_PATH_UNAVAILABLE: u8 = 67;
const EXIT_RESTRICT_FAILED: u8 = 68;
const EXIT_EXEC_FAILED: u8 = 69;

#[derive(Deserialize)]
struct RulesetSpec {
    version: u32,
    #[serde(rename = "requireAbi")]
    require_abi: u32,
    rules: Vec<RuleSpec>,
}

#[derive(Deserialize)]
struct RuleSpec {
    path: String,
    access: Vec<String>,
}

struct Args {
    ruleset_file: String,
    check_only: bool,
    command: Option<(String, Vec<OsString>)>,
}

fn main() -> ExitCode {
    // stdout は fd0/1/2 のうち fd1——JSON-RPC transport が使う。
    // このプロセスは stdout に一切書き込まない。診断は全部 stderr。
    let args = match parse_argv() {
        Ok(a) => a,
        Err(msg) => {
            emit_error("usage_error", &msg, &BTreeMap::new());
            return ExitCode::from(EXIT_USAGE);
        }
    };

    let raw = match fs::read(&args.ruleset_file) {
        Ok(b) => b,
        Err(e) => {
            emit_error(
                "ruleset_file_unreadable",
                &format!("{}: {e}", args.ruleset_file),
                &BTreeMap::new(),
            );
            return ExitCode::from(EXIT_BAD_RULESET_FILE);
        }
    };
    let spec: RulesetSpec = match serde_json::from_slice(&raw) {
        Ok(s) => s,
        Err(e) => {
            emit_error("ruleset_file_invalid", &e.to_string(), &BTreeMap::new());
            return ExitCode::from(EXIT_BAD_RULESET_FILE);
        }
    };
    if spec.version != 1 {
        emit_error(
            "ruleset_version_unsupported",
            &format!("got version {}, this binary supports 1", spec.version),
            &BTreeMap::new(),
        );
        return ExitCode::from(EXIT_BAD_RULESET_FILE);
    }
    if spec.require_abi > REQUIRED_ABI as u32 {
        // TS 側が、このバイナリが対応する ABI より高い版を要求してきた——
        // バイナリの更新が要る。黙って低い版で妥協しない。
        emit_error(
            "ruleset_requires_newer_binary",
            &format!(
                "ruleset requires ABI {}, this binary supports up to {}",
                spec.require_abi, REQUIRED_ABI as u32
            ),
            &BTreeMap::new(),
        );
        return ExitCode::from(EXIT_ABI_INSUFFICIENT);
    }

    // HardRequirement: 対応していないカーネルでは Err を返す（既定の
    // BestEffort は黙って降格するので、ここでは使わない）。
    let ruleset_build = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(REQUIRED_ABI));

    let ruleset = match ruleset_build {
        Ok(r) => r,
        Err(e) => {
            emit_error(
                "abi_insufficient",
                &format!("handle_access failed (kernel too old or Landlock disabled): {e}"),
                &BTreeMap::new(),
            );
            return ExitCode::from(EXIT_ABI_INSUFFICIENT);
        }
    };

    let mut created = match ruleset.create() {
        Ok(c) => c,
        Err(e) => {
            emit_error("ruleset_create_failed", &e.to_string(), &BTreeMap::new());
            return ExitCode::from(EXIT_RESTRICT_FAILED);
        }
    };

    let mut applied_rules = 0usize;
    for rule in &spec.rules {
        let access = match parse_access(&rule.access) {
            Ok(a) => a,
            Err(bad) => {
                emit_error(
                    "unknown_access_right",
                    &format!("path {}: unknown access {bad:?}", rule.path),
                    &BTreeMap::new(),
                );
                return ExitCode::from(EXIT_USAGE);
            }
        };
        let fd = match PathFd::new(&rule.path) {
            Ok(fd) => fd,
            Err(e) => {
                emit_error(
                    "path_unavailable",
                    &format!("cannot open {}: {e}", rule.path),
                    &BTreeMap::from([("path".to_string(), rule.path.clone())]),
                );
                return ExitCode::from(EXIT_PATH_UNAVAILABLE);
            }
        };
        created = match created.add_rule(PathBeneath::new(fd, access)) {
            Ok(r) => r,
            Err(e) => {
                emit_error(
                    "add_rule_failed",
                    &format!("path {}: {e}", rule.path),
                    &BTreeMap::new(),
                );
                return ExitCode::from(EXIT_PATH_UNAVAILABLE);
            }
        };
        applied_rules += 1;
    }

    if args.check_only {
        // 実際には restrict_self() を呼ばない——検査だけ。
        // ここまで到達したこと自体が「このカーネルで ABI 4 の
        // ルールセットを作れる」ことの実測結果。
        emit_info(
            "check_ok",
            &BTreeMap::from([
                ("abi".to_string(), (REQUIRED_ABI as u32).to_string()),
                ("ruleCount".to_string(), applied_rules.to_string()),
            ]),
        );
        return ExitCode::SUCCESS;
    }

    let status = match created.restrict_self() {
        Ok(s) => s,
        Err(e) => {
            emit_error("restrict_self_failed", &e.to_string(), &BTreeMap::new());
            return ExitCode::from(EXIT_RESTRICT_FAILED);
        }
    };

    // crate の既定は best-effort で「部分的に強制された」状態を許すが、
    // banto は「守れていないが動く」を許さない（規則2）。
    if status.ruleset != RulesetStatus::FullyEnforced {
        emit_error(
            "not_fully_enforced",
            &format!("ruleset status = {:?}", status.ruleset),
            &BTreeMap::new(),
        );
        return ExitCode::from(EXIT_RESTRICT_FAILED);
    }
    if !status.no_new_privs {
        emit_error(
            "no_new_privs_not_set",
            "PR_SET_NO_NEW_PRIVS was not enforced",
            &BTreeMap::new(),
        );
        return ExitCode::from(EXIT_RESTRICT_FAILED);
    }

    emit_info(
        "enforced",
        &BTreeMap::from([
            ("abi".to_string(), (REQUIRED_ABI as u32).to_string()),
            ("ruleCount".to_string(), applied_rules.to_string()),
        ]),
    );

    let (cmd, cmd_args) = args.command.expect("checked in parse_argv");
    // exec() はプロセスイメージを置き換えるだけ——pid・fd 0/1/2 は
    // そのまま引き継がれる。Landlock の制限は execve をまたいで残る。
    let err = Command::new(&cmd).args(&cmd_args).exec();
    emit_error(
        "exec_failed",
        &format!("{cmd}: {err}"),
        &BTreeMap::new(),
    );
    ExitCode::from(EXIT_EXEC_FAILED)
}

fn parse_access(names: &[String]) -> Result<BitFlags<AccessFs>, String> {
    let mut flags = BitFlags::<AccessFs>::empty();
    for name in names {
        let flag = match name.as_str() {
            "execute" => AccessFs::Execute,
            "write_file" => AccessFs::WriteFile,
            "read_file" => AccessFs::ReadFile,
            "read_dir" => AccessFs::ReadDir,
            "remove_dir" => AccessFs::RemoveDir,
            "remove_file" => AccessFs::RemoveFile,
            "make_char" => AccessFs::MakeChar,
            "make_dir" => AccessFs::MakeDir,
            "make_reg" => AccessFs::MakeReg,
            "make_sock" => AccessFs::MakeSock,
            "make_fifo" => AccessFs::MakeFifo,
            "make_block" => AccessFs::MakeBlock,
            "make_sym" => AccessFs::MakeSym,
            "refer" => AccessFs::Refer,
            "truncate" => AccessFs::Truncate,
            other => return Err(other.to_string()),
        };
        flags |= flag;
    }
    Ok(flags)
}

fn parse_argv() -> Result<Args, String> {
    let mut it = std::env::args_os();
    let _argv0 = it.next();

    let mut ruleset_file: Option<String> = None;
    let mut check_only = false;

    loop {
        let a = it.next();
        match a {
            None => {
                let ruleset_file =
                    ruleset_file.ok_or_else(|| "missing --ruleset-file".to_string())?;
                if check_only {
                    return Ok(Args {
                        ruleset_file,
                        check_only,
                        command: None,
                    });
                }
                return Err("missing '--' <command>".to_string());
            }
            Some(v) if v == "--ruleset-file" => {
                let val = it
                    .next()
                    .ok_or_else(|| "--ruleset-file requires a value".to_string())?;
                ruleset_file = Some(val.to_string_lossy().into_owned());
            }
            Some(v) if v == "--check-only" => {
                check_only = true;
            }
            Some(v) if v == "--" => {
                let ruleset_file =
                    ruleset_file.ok_or_else(|| "missing --ruleset-file".to_string())?;
                let cmd = it.next().ok_or_else(|| "missing command after --".to_string())?;
                let rest: Vec<OsString> = it.collect();
                return Ok(Args {
                    ruleset_file,
                    check_only,
                    command: Some((cmd.to_string_lossy().into_owned(), rest)),
                });
            }
            Some(v) => {
                return Err(format!("unknown argument: {}", v.to_string_lossy()));
            }
        }
    }
}

fn emit_error(code: &str, message: &str, extra: &BTreeMap<String, String>) {
    emit_line("error", code, message, extra);
}

fn emit_info(code: &str, extra: &BTreeMap<String, String>) {
    emit_line("info", code, "", extra);
}

fn emit_line(level: &str, code: &str, message: &str, extra: &BTreeMap<String, String>) {
    let mut obj = serde_json::Map::new();
    obj.insert("src".into(), "banto-landlock-exec".into());
    obj.insert("level".into(), level.into());
    obj.insert("code".into(), code.into());
    if !message.is_empty() {
        obj.insert("message".into(), message.into());
    }
    for (k, v) in extra {
        obj.insert(k.clone(), v.clone().into());
    }
    eprintln!("{}", serde_json::Value::Object(obj));
}
