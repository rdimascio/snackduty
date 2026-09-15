/**
 * THE xcodebuild "did any test actually run?" guard, in exactly ONE place.
 *
 * xcodebuild prints `** TEST SUCCEEDED **` and exits 0 for a run that matched
 * ZERO tests — an `-only-testing` selector that names nothing (Swift Testing
 * function identifiers do exactly this), a suite renamed out from under a
 * filter, a scheme whose test action was emptied. A green exit code is
 * therefore NOT evidence that anything was verified, and neither is the
 * success banner: both appear on a run that executed nothing.
 *
 * All iOS entry points route their verdict through this module, so the guard
 * can never be strong on one path and absent on the other:
 *
 *   - `scripts/ios-test.sh` — the GATED whole-scheme run (`bun run gate` →
 *     `bun run test` → `apps/ios` `test`). It shells out to the CLI at the
 *     bottom of this file with the captured log, xcodebuild's exit code, and
 *     the UI smoke test it requires in addition to the Swift Testing suites.
 *   - `scripts/ios-ui-test.sh` — a focused XCTest UI run. It uses named-only
 *     mode because this selector intentionally runs no Swift Testing bundle.
 *   - `scripts/acceptance.ts` — the live round trip (`bun run accept`). It
 *     imports `zeroTestProblems` and adds `namedTestProblems` for the one test
 *     that leg exists to run.
 *
 * Every check returns PROBLEM STRINGS rather than throwing, so each caller can
 * report them in its own idiom (a `StepFailure` in the acceptance journey,
 * stderr plus a nonzero exit in the shell wrapper).
 */

export const TEST_SUCCEEDED = "** TEST SUCCEEDED **";

/**
 * Swift Testing prints one verdict line per test — `✔ Test <name> passed after
 * …` — plus a per-bundle summary line, `✔ Test run with <n> tests passed …`.
 * The lookahead keeps the summary out of the individual-test count so a run
 * that summarizes zero tests can never satisfy the "at least one test passed"
 * check by itself.
 */
const INDIVIDUAL_PASS = /✔\s+Test\s+(?!run with\b)[^\n]*\spassed\b/gu;
const RUN_SUMMARY_PASS = /✔\s+Test run with (\d+) tests? passed\b/gu;
const RUN_SUMMARY_FAIL = /✘\s+Test run with [^\n]*\sfailed\b/u;

function count(output: string, pattern: RegExp): number {
  return [...output.matchAll(pattern)].length;
}

/** Exit/banner checks shared by Swift-suite and named-only XCTest runs. */
export function baseRunProblems(exitCode: number, output: string): readonly string[] {
  const problems: string[] = [];
  if (exitCode !== 0) problems.push(`xcodebuild exited ${exitCode}`);
  if (!output.includes(TEST_SUCCEEDED)) {
    problems.push(`xcodebuild never printed "${TEST_SUCCEEDED}"`);
  }
  return problems;
}

/**
 * Everything that makes an xcodebuild run untrustworthy AS EVIDENCE, given its
 * exit code and combined stdout+stderr. An empty list means tests really ran
 * and really passed.
 *
 * The checks, in the order they read:
 *   - a nonzero exit is a failure, full stop;
 *   - `** TEST SUCCEEDED **` must be present — but is never sufficient on its
 *     own, which is the whole point of the checks below it;
 *   - at least one INDIVIDUAL test must report a pass verdict, which is what a
 *     zero-match selector and an everything-was-skipped run both fail;
 *   - at least one bundle must summarize a nonzero test count;
 *   - no bundle may summarize a failure.
 */
export function zeroTestProblems(exitCode: number, output: string): readonly string[] {
  const problems = [...baseRunProblems(exitCode, output)];

  if (count(output, INDIVIDUAL_PASS) === 0) {
    problems.push(
      "no individual test reported a pass verdict — xcodebuild reported success without running " +
        "anything (a selector that matches no tests, or a run where every test was skipped)",
    );
  }

  const summarized = [...output.matchAll(RUN_SUMMARY_PASS)].map((match) => Number(match[1]));
  if (summarized.length === 0) {
    problems.push("no test bundle printed a passing Swift Testing run summary");
  } else if (summarized.every((tests) => tests === 0)) {
    problems.push("every Swift Testing run summary reported 0 tests");
  }

  const failure = RUN_SUMMARY_FAIL.exec(output);
  if (failure !== null) problems.push(`a Swift Testing run reported failure: ${failure[0].trim()}`);

  return problems;
}

/**
 * The same trap for ONE named test that a wrapper exists to run: it must be
 * mentioned, it must not be skipped, and it must report its own pass verdict.
 * `namePattern` is a regex source fragment matching the test's display name (or
 * its identifier); `label` names it in human terms for the failure message.
 *
 * A skipped test is a silent no-op acceptance — the verdict line names the test
 * and its lowercase "skipped" is what distinguishes it from an uppercase
 * "SKIPPED" inside a test's own display name.
 */
export function namedTestProblems(
  output: string,
  label: string,
  namePattern: string,
): readonly string[] {
  const problems: string[] = [];
  const mentioned = new RegExp(namePattern, "u");
  const skipped = new RegExp(`(?:${namePattern})[^\\n]*skipped`, "u");
  const passed = new RegExp(`(?:${namePattern})[^\\n]*passed|passed[^\\n]*(?:${namePattern})`, "u");

  if (!mentioned.test(output)) {
    problems.push(`xcodebuild output never mentions ${label}`);
    return problems;
  }
  if (skipped.test(output)) {
    problems.push(`${label} was SKIPPED — it never reached the test runner`);
  }
  if (!passed.test(output)) problems.push(`no pass verdict for ${label} in the xcodebuild output`);

  return problems;
}

export interface NamedTestRequirement {
  readonly label: string;
  readonly namePattern: string;
}

export interface VerdictRequirements {
  /** Disable only for a focused XCTest invocation that intentionally runs no Swift Testing suite. */
  readonly requireSwiftTests?: boolean;
  readonly namedTest?: NamedTestRequirement;
}

/** Compose the canonical verdict for whole-scheme and focused named-test runs. */
export function xcodebuildProblems(
  exitCode: number,
  output: string,
  requirements: VerdictRequirements = {},
): readonly string[] {
  const problems =
    requirements.requireSwiftTests === false
      ? [...baseRunProblems(exitCode, output)]
      : [...zeroTestProblems(exitCode, output)];

  if (requirements.namedTest !== undefined) {
    problems.push(
      ...namedTestProblems(
        output,
        requirements.namedTest.label,
        requirements.namedTest.namePattern,
      ),
    );
  }
  return problems;
}

/**
 * CLI form for the shell wrappers. `--named-test` adds one required test to the
 * normal Swift-suite checks; `--named-only` applies exit/banner/named checks to
 * a focused XCTest run that intentionally has no Swift Testing summary.
 */
if (import.meta.main) {
  const [logPath, exitCodeArgument, mode, label, namePattern, ...unexpected] =
    process.argv.slice(2);
  const hasNamedMode = mode === "--named-test" || mode === "--named-only";
  const invalidNamedMode = mode !== undefined && !hasNamedMode;
  const missingNamedArgument = hasNamedMode && (label === undefined || namePattern === undefined);
  if (
    logPath === undefined ||
    exitCodeArgument === undefined ||
    invalidNamedMode ||
    missingNamedArgument ||
    unexpected.length > 0
  ) {
    console.error(
      "usage: bun scripts/lib/xcodebuild-verdict.ts <log-file> <xcodebuild-exit-code> " +
        "[--named-test|--named-only <label> <name-pattern>]",
    );
    process.exit(2);
  }

  const namedTest =
    hasNamedMode && label !== undefined && namePattern !== undefined
      ? { label, namePattern }
      : undefined;
  const requirements: VerdictRequirements =
    namedTest === undefined
      ? { requireSwiftTests: mode !== "--named-only" }
      : { requireSwiftTests: mode !== "--named-only", namedTest };
  const problems = xcodebuildProblems(
    Number(exitCodeArgument),
    await Bun.file(logPath).text(),
    requirements,
  );
  if (problems.length > 0) {
    console.error("error: this xcodebuild run is not evidence that the iOS tests passed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
