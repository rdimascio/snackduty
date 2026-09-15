import {
  backupSqliteFile,
  restoreSqliteBackup,
  verifySqliteIntegrity,
} from "../../apps/web/runtime/backup";

async function main(args: readonly string[]): Promise<void> {
  const [command, sourcePath, targetPath] = args;

  if (command === "verify" && sourcePath !== undefined && targetPath === undefined) {
    await verifySqliteIntegrity(sourcePath);
    console.log(JSON.stringify({ path: sourcePath, integrity: "ok" }, null, 2));
    return;
  }

  if (command === "backup" && sourcePath !== undefined && targetPath !== undefined) {
    console.log(JSON.stringify(await backupSqliteFile(sourcePath, targetPath), null, 2));
    return;
  }

  if (command === "restore" && sourcePath !== undefined && targetPath !== undefined) {
    console.log(JSON.stringify(await restoreSqliteBackup(sourcePath, targetPath), null, 2));
    return;
  }

  throw new Error(
    "Usage: bun scripts/runtime/storage.ts verify <absolute-db> | backup <absolute-db> <absolute-backup> | restore <absolute-backup> <new-absolute-db>",
  );
}

if (import.meta.main) await main(process.argv.slice(2));
