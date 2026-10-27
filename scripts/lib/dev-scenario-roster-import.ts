import { DevScenarioApi, ensure } from "./dev-scenario-api";

interface ImportPreviewResponse {
  readonly rows?: readonly { readonly verdict?: string; readonly row?: unknown }[];
}

interface ImportCommitResponse {
  readonly summary?: { readonly created?: number };
}

export interface ImportedPlayer {
  readonly displayName: string;
  readonly birthDate: string;
}

export function rosterCsv(players: readonly ImportedPlayer[]): string {
  return [
    "child_name,birth_date",
    ...players.map((player) => `${player.displayName},${player.birthDate}`),
  ].join("\n");
}

export class DevScenarioRosterImportApi extends DevScenarioApi {
  async importPlayers(
    cookie: string,
    teamId: string,
    seasonId: string,
    players: readonly ImportedPlayer[],
  ): Promise<void> {
    const importPath = `/api/teams/${teamId}/seasons/${seasonId}/roster/import`;
    const preview = await this.json<ImportPreviewResponse>(
      "preview-roster-import",
      `${importPath}/preview`,
      {
        method: "POST",
        headers: this.mutation(cookie),
        body: JSON.stringify({ csv: rosterCsv(players) }),
      },
      200,
    );
    const rows = (preview.rows ?? []).flatMap((row) =>
      row.verdict === "valid" && row.row !== undefined ? [row.row] : [],
    );
    ensure(
      "preview-roster-import",
      rows.length === players.length,
      `preview marked ${rows.length} of ${players.length} rows valid`,
    );
    const committed = await this.json<ImportCommitResponse>(
      "commit-roster-import",
      importPath,
      { method: "POST", headers: this.mutation(cookie), body: JSON.stringify({ rows }) },
      201,
    );
    ensure(
      "commit-roster-import",
      committed.summary?.created === players.length,
      `import created ${String(committed.summary?.created)} of ${players.length} players`,
    );
  }
}
