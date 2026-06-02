import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.PI_CODE_INTEL_RUNTIME_LOG = path.join(os.tmpdir(), `code-intel-runtime-test-${process.pid}.jsonl`);
process.env.PI_CODE_INTEL_USAGE_LOG = path.join(os.tmpdir(), `code-intel-usage-test-${process.pid}.jsonl`);
for (const logPath of [process.env.PI_CODE_INTEL_RUNTIME_LOG, process.env.PI_CODE_INTEL_USAGE_LOG]) {
	try {
		fs.rmSync(logPath);
	} catch {
		// Ignore missing prior test diagnostics.
	}
}

export function hasCommand(command: string): boolean {
	try {
		execFileSync("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function fixtureRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-intel-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "main.ts"), `export function authenticate(token: string): boolean {
  return token.length > 0
}

export function loginHandler(token: string) {
  if (authenticate(token)) {
    return "ok"
  }
  return "no"
}

export function unusedHandler() {
  return authenticate("test")
}

export interface SelectorSource {
  NeedTags: boolean
}

export function needsTags(selector: SelectorSource): boolean {
  if (selector.NeedTags) return true
  return false
}

export const selector: SelectorSource = { NeedTags: true }
`);
	fs.writeFileSync(path.join(dir, "main.test.ts"), `import { authenticate } from "./main"

function testHelper() {
  return authenticate("helper")
}

const mock = {
  on() {
    return authenticate("hook")
  },
}
`);
	fs.writeFileSync(path.join(dir, "selector.go"), `package main

type SelectorSourceGo struct { NeedTags bool }

func buildMatchedSeriesSQL() {}
func (s SelectorSourceGo) load() bool { return true }

func caller(selector SelectorSourceGo) {
	buildMatchedSeriesSQL()
	if selector.NeedTags {}
	selector.load()
	_ = SelectorSourceGo{NeedTags: true}
}
`);
	fs.writeFileSync(path.join(dir, "watcher.py"), `def load_state(path):
    return {}


def save_state(path, state):
    return None


def run_poll_cycle(config):
    state = load_state(config["state"])
    save_state(config["state"], state)
`);
	return dir;
}
