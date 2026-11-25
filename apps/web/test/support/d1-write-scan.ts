import ts from "typescript";

export type WriteSiteKind = "batch" | "transaction" | "guarded-runner" | "indirect";

export interface WriteSite {
  readonly file: string;
  readonly line: number;
  readonly kind: WriteSiteKind;
  readonly guarded: boolean;
  readonly owner: string;
}

/** `file#owner` of an unguarded `.batch(` site, mapped to the reason it may run without a proof. */
export type BatchAllowlist = Readonly<Record<string, string>>;

const DB_METHODS: ReadonlySet<string> = new Set(["batch", "transaction"]);
const GUARDED_RUNNER = "runGuardedBatch";
const GUARDED_RUNNER_ARGUMENTS = 3;
const GUARDED_RUNNER_GUARD_INDEX = 1;
const ABORT_UNLESS = "abortUnless";
const PROOF_GUARD = "proofGuard";
const PROOFS = "proofs";
const MODULE_OWNER = "<module>";

function calleeName(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

function isProofsIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  const namesAProperty = ts.isPropertyAssignment(parent) && parent.name === node;
  return node.text === PROOFS && !namesAProperty && !ts.isVoidExpression(parent);
}

function referencesProofs(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === PROOFS) return true;
  if (ts.isIdentifier(node) && isProofsIdentifier(node)) return true;
  if (ts.isCallExpression(node) && calleeName(node) === PROOF_GUARD) return true;
  if (ts.isVoidExpression(node)) return false;
  return ts.forEachChild(node, (child) => referencesProofs(child) || undefined) ?? false;
}

function isAbortUnlessCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && calleeName(node) === ABORT_UNLESS;
}

function isProvenSingleWrite(node: ts.Node): boolean {
  return ts.isCallExpression(node) && node.arguments.some(referencesProofs);
}

function batchIsGuarded(call: ts.CallExpression): boolean {
  const [statements] = call.arguments;
  if (call.arguments.length !== 1 || statements === undefined) return false;
  if (!ts.isArrayLiteralExpression(statements)) return false;
  const elements = statements.elements;
  if (elements.some(isAbortUnlessCall)) return true;
  const [only] = elements;
  return elements.length === 1 && only !== undefined && isProvenSingleWrite(only);
}

function guardedRunnerHasGuard(call: ts.CallExpression): boolean {
  const guard = call.arguments[GUARDED_RUNNER_GUARD_INDEX];
  return (
    call.arguments.length === GUARDED_RUNNER_ARGUMENTS &&
    guard !== undefined &&
    referencesProofs(guard)
  );
}

function namesDbMethod(node: ts.Expression): boolean {
  return ts.isStringLiteralLike(node) && DB_METHODS.has(node.text);
}

function isCallee(node: ts.Node): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function isDestructuredDbMethod(node: ts.Node): boolean {
  if (!ts.isBindingElement(node) || !ts.isObjectBindingPattern(node.parent)) return false;
  const key = node.propertyName ?? node.name;
  return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && DB_METHODS.has(key.text);
}

function ownerName(node: ts.Node): string {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText();
    }
    const isFunctionValue = ts.isArrowFunction(current) || ts.isFunctionExpression(current);
    if (isFunctionValue && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
    if (isFunctionValue && ts.isPropertyAssignment(current.parent)) {
      return current.parent.name.getText();
    }
  }
  return MODULE_OWNER;
}

function siteKind(node: ts.Node): { kind: WriteSiteKind; guarded: boolean } | undefined {
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && DB_METHODS.has(callee.name.text)) {
      return callee.name.text === "batch"
        ? { kind: "batch", guarded: batchIsGuarded(node) }
        : { kind: "transaction", guarded: false };
    }
    if (ts.isElementAccessExpression(callee) && namesDbMethod(callee.argumentExpression)) {
      return { kind: "indirect", guarded: false };
    }
    if (calleeName(node) === GUARDED_RUNNER) {
      return { kind: "guarded-runner", guarded: guardedRunnerHasGuard(node) };
    }
    return undefined;
  }
  const referencesDbMethod =
    (ts.isPropertyAccessExpression(node) && DB_METHODS.has(node.name.text)) ||
    (ts.isElementAccessExpression(node) && namesDbMethod(node.argumentExpression));
  if ((referencesDbMethod && !isCallee(node)) || isDestructuredDbMethod(node)) {
    return { kind: "indirect", guarded: false };
  }
  return undefined;
}

/** Every batch, transaction, guarded runner and indirect batch or transaction reference in one source file. */
export function scanWriteSites(file: string, text: string): WriteSite[] {
  const scriptKind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  const sites: WriteSite[] = [];
  const visit = (node: ts.Node) => {
    const found = siteKind(node);
    if (found !== undefined) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      sites.push({ file, line: line + 1, owner: ownerName(node), ...found });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

export const siteKey = (site: WriteSite) => `${site.file}#${site.owner}`;
export const siteLocation = (site: WriteSite) => `app/${site.file}:${site.line}`;

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function isAllowlisted(
  site: WriteSite,
  allowlist: BatchAllowlist,
  counts: ReadonlyMap<string, number>,
): boolean {
  return site.kind === "batch" && siteKey(site) in allowlist && counts.get(siteKey(site)) === 1;
}

/** Unguarded writes with no allowlist entry; indirect references always fail. */
export function unguardedWrites(sites: readonly WriteSite[], allowlist: BatchAllowlist): string[] {
  const unguarded = sites.filter((site) => site.kind !== "transaction" && !site.guarded);
  const counts = countBy(
    unguarded.filter((site) => site.kind === "batch"),
    siteKey,
  );
  return unguarded
    .filter((site) => !isAllowlisted(site, allowlist, counts))
    .map((site) => `${siteLocation(site)} unguarded ${site.kind} in ${site.owner}`);
}

/** Allowlist entries that match no unguarded batch. */
export function staleAllowlistEntries(
  sites: readonly WriteSite[],
  allowlist: BatchAllowlist,
): string[] {
  const unguardedKeys = new Set(
    sites.filter((site) => site.kind === "batch" && !site.guarded).map(siteKey),
  );
  return Object.keys(allowlist).filter((key) => !unguardedKeys.has(key));
}

/** Transactions past a file's frozen count, and frozen counts the file no longer reaches. */
export function transactionDrift(
  sites: readonly WriteSite[],
  frozen: Readonly<Record<string, number>>,
): { readonly added: string[]; readonly lowered: string[] } {
  const transactions = sites.filter((site) => site.kind === "transaction");
  const counts = countBy(transactions, (site) => site.file);
  return {
    added: transactions
      .filter((site) => (counts.get(site.file) ?? 0) > (frozen[site.file] ?? 0))
      .map((site) => `${siteLocation(site)} transaction in ${site.owner}`),
    lowered: Object.entries(frozen)
      .filter(([file, count]) => (counts.get(file) ?? 0) < count)
      .map(([file, count]) => `app/${file} froze ${count}, has ${counts.get(file) ?? 0}`),
  };
}
