import * as vscode from "vscode";
import { Client } from "pg";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type DbType = "postgres" | "mysql" | "oracle";

interface Connection {
  id: string;
  label: string;
  type: "postgres" | "vanna";
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  vannaUrl?: string;
  dbType?: DbType;
}

interface AppSettings { fontSize: number; queryLimit: number; }
const DEFAULT_SETTINGS: AppSettings = { fontSize: 13, queryLimit: 100 };

const DB_TYPE_LABELS: Record<DbType, string> = {
  postgres: "🐘 PostgreSQL",
  mysql: "🐬 MySQL",
  oracle: "🔶 Oracle",
};

// ─────────────────────────────────────────────────────────────
// ACTIVATE
// ─────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new ConnTreeProvider(context);
  vscode.window.registerTreeDataProvider("pgExplorer.connectionsView", treeProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand("pgExplorer.addConnection", () => openAddForm(context, treeProvider)),
    vscode.commands.registerCommand("pgExplorer.deleteConnection", (node: TreeNode) => deleteConn(context, treeProvider, node)),
    vscode.commands.registerCommand("pgExplorer.refreshTree", () => treeProvider.refresh()),
    vscode.commands.registerCommand("pgExplorer.openQueryRunner", (node: TreeNode) => openQueryPanel(context, node)),
    vscode.commands.registerCommand("pgExplorer.openSettings", () => openSettingsPanel(context)),
    vscode.commands.registerCommand("pgExplorer.openAskAI", () => openAskAIPanel(context)),
  );
}
export function deactivate() { }

// ─────────────────────────────────────────────────────────────
// TREE
// ─────────────────────────────────────────────────────────────
class TreeNode extends vscode.TreeItem {
  constructor(
    public readonly nodeType: "section" | "conn" | "empty",
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly conn?: Connection,
    public readonly sectionKind?: "vanna" | "postgres",
  ) {
    super(label, collapsible);
    if (nodeType === "section") {
      this.contextValue = "section";
      this.iconPath = new vscode.ThemeIcon(sectionKind === "vanna" ? "sparkle" : "database");
    } else if (nodeType === "conn" && conn) {
      this.contextValue = "connection";
      this.iconPath = new vscode.ThemeIcon(conn.type === "vanna" ? "plug" : "server");
      this.description = conn.type === "vanna" ? conn.vannaUrl : `${conn.host}/${conn.database}`;
      this.tooltip = conn.type === "vanna"
        ? `Vanna AI — ${conn.vannaUrl}\nDatabase: ${DB_TYPE_LABELS[conn.dbType ?? "postgres"]}`
        : `PostgreSQL — ${conn.host}:${conn.port}/${conn.database}`;
      this.command = { command: "pgExplorer.openQueryRunner", title: "Open", arguments: [this] };
    } else if (nodeType === "empty") {
      this.contextValue = "empty";
      this.iconPath = new vscode.ThemeIcon("info");
    }
  }
}

class ConnTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _change = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._change.event;
  constructor(private ctx: vscode.ExtensionContext) { }
  refresh() { this._change.fire(undefined); }
  getTreeItem(el: TreeNode) { return el; }

  getChildren(el?: TreeNode): TreeNode[] {
    const all = this.ctx.globalState.get<Connection[]>("pg.connections", []);

    if (!el) {
      return [
        new TreeNode("section", "⚡ Vanna AI", vscode.TreeItemCollapsibleState.Expanded, undefined, "vanna"),
        new TreeNode("section", "🐘 PostgreSQL", vscode.TreeItemCollapsibleState.Expanded, undefined, "postgres"),
      ];
    }

    if (el.nodeType === "section" && el.sectionKind === "vanna") {
      const list = all.filter(c => c.type === "vanna");
      if (!list.length) return [new TreeNode("empty", "Click + to add Vanna connection", vscode.TreeItemCollapsibleState.None)];
      return list.map(c => new TreeNode("conn", c.label, vscode.TreeItemCollapsibleState.None, c));
    }

    if (el.nodeType === "section" && el.sectionKind === "postgres") {
      const list = all.filter(c => c.type === "postgres");
      if (!list.length) return [new TreeNode("empty", "Click + to add PostgreSQL connection", vscode.TreeItemCollapsibleState.None)];
      return list.map(c => new TreeNode("conn", c.label, vscode.TreeItemCollapsibleState.None, c));
    }

    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// ADD CONNECTION FORM
// ─────────────────────────────────────────────────────────────
function openAddForm(context: vscode.ExtensionContext, tree: ConnTreeProvider) {
  const panel = vscode.window.createWebviewPanel(
    "pgExplorer.addConnection", "Add Connection",
    vscode.ViewColumn.One, { enableScripts: true }
  );
  panel.webview.html = getAddFormHtml();

  panel.webview.onDidReceiveMessage(async (msg) => {

    if (msg.command === "saveVanna") {
      const conn: Connection = {
        id: Date.now().toString(),
        label: (msg.data.label || msg.data.vannaUrl).trim(),
        type: "vanna",
        vannaUrl: msg.data.vannaUrl.trim().replace(/\/$/, ""),
        dbType: (msg.data.dbType as DbType) || "postgres",
      };
      try {
        panel.webview.postMessage({ command: "status", text: "⏳ Testing Vanna connection..." });
        const r = await fetch(`${conn.vannaUrl}/health`);
        if (!r.ok) throw new Error("fail");
      } catch {
        panel.webview.postMessage({ command: "status", text: "❌ Cannot reach Vanna — run: python api.py", error: true });
        return;
      }
      await saveConn(context, conn); tree.refresh();
      const dbLabel = DB_TYPE_LABELS[conn.dbType!];
      panel.webview.postMessage({ command: "status", text: `✅ "${conn.label}" connected (${dbLabel})`, success: true });
      setTimeout(() => panel.dispose(), 1500);
    }

    if (msg.command === "savePostgres") {
      const conn: Connection = {
        id: Date.now().toString(),
        label: (msg.data.label || `${msg.data.host}/${msg.data.database}`).trim(),
        type: "postgres",
        host: msg.data.host.trim(), port: parseInt(msg.data.port) || 5432,
        user: msg.data.user.trim(), password: msg.data.password, database: msg.data.database.trim(),
      };
      try {
        panel.webview.postMessage({ command: "status", text: "⏳ Testing connection..." });
        const client = new Client({
          host: conn.host, port: conn.port, user: conn.user,
          password: conn.password, database: conn.database,
          connectionTimeoutMillis: 5000,
        });
        await client.connect(); await client.end();
      } catch (e: any) {
        panel.webview.postMessage({ command: "status", text: `❌ ${e.message}`, error: true });
        return;
      }
      await saveConn(context, conn); tree.refresh();
      panel.webview.postMessage({ command: "status", text: `✅ "${conn.label}" added under 🐘 PostgreSQL!`, success: true });
      setTimeout(() => panel.dispose(), 1500);
    }
  });
}

async function saveConn(context: vscode.ExtensionContext, conn: Connection) {
  const list = context.globalState.get<Connection[]>("pg.connections", []);
  list.push(conn);
  await context.globalState.update("pg.connections", list);
}

// ─────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────
async function deleteConn(context: vscode.ExtensionContext, tree: ConnTreeProvider, node: TreeNode) {
  if (!node.conn) return;
  const ok = await vscode.window.showWarningMessage(`Remove "${node.conn.label}"?`, "Remove", "Cancel");
  if (ok !== "Remove") return;
  const list = context.globalState.get<Connection[]>("pg.connections", []).filter(c => c.id !== node.conn!.id);
  await context.globalState.update("pg.connections", list);
  tree.refresh();
}

// ─────────────────────────────────────────────────────────────
// QUERY PANEL
// ─────────────────────────────────────────────────────────────
function openQueryPanel(context: vscode.ExtensionContext, node: TreeNode) {
  if (!node.conn) return;
  const conn = node.conn;
  const settings = context.globalState.get<AppSettings>("pg.settings", DEFAULT_SETTINGS);

  const dbLabel = conn.type === "vanna"
    ? DB_TYPE_LABELS[conn.dbType ?? "postgres"]
    : "🐘 PostgreSQL";

  const panel = vscode.window.createWebviewPanel(
    "pgExplorer.queryRunner", `Query — ${conn.label}`,
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = getQueryRunnerHtml(
    conn.label, conn.type, settings.fontSize, settings.queryLimit,
    conn.vannaUrl, dbLabel
  );

  panel.webview.onDidReceiveMessage(async (msg) => {

    if (msg.command === "runSQL") {
      const sql = msg.sql?.trim(); if (!sql) return;
      panel.webview.postMessage({ command: "loading" });
      try {
        if (conn.type === "postgres") {
          const client = new Client({
            host: conn.host, port: conn.port, user: conn.user,
            password: conn.password, database: conn.database,
            connectionTimeoutMillis: 5000,
          });
          await client.connect();
          const t = Date.now(); const r = await client.query(sql); const elapsed = Date.now() - t;
          await client.end();
          const columns = r.fields.map((f: any) => f.name);
          const rows = r.rows.map((row: any) => columns.map((c: string) => row[c]));
          panel.webview.postMessage({ command: "results", sql, columns, rows, rowCount: r.rowCount, elapsed, source: "sql" });
        } else {
          const result = await askVannaAPI(conn.vannaUrl!, `Run this exact SQL: ${sql}`, conn.dbType ?? "postgres");
          if (result.columns && result.rows && result.rows.length > 0) {
            panel.webview.postMessage({ command: "results", sql, columns: result.columns, rows: result.rows, rowCount: result.rows.length, elapsed: 0, source: "sql" });
          } else {
            panel.webview.postMessage({ command: "results", sql, columns: ["Response"], rows: [[result.text || "No results returned"]], rowCount: 1, elapsed: 0, source: "sql" });
          }
        }
      } catch (e: any) { panel.webview.postMessage({ command: "queryError", message: e.message }); }
    }

    if (msg.command === "askAI") {
      const q = msg.question?.trim(); if (!q) return;
      panel.webview.postMessage({ command: "aiLoading" });
      try {
        if (conn.type !== "vanna") {
          throw new Error("Ask AI requires a Vanna connection.\nAdd one using the + button → ⚡ Vanna AI tab.");
        }

        const result = await askVannaAPI(conn.vannaUrl!, q, conn.dbType ?? "postgres");

        if (result.sql) {
          panel.webview.postMessage({ command: "sqlGenerated", sql: result.sql });
        }

        if (result.columns && result.rows && result.rows.length > 0) {
          panel.webview.postMessage({
            command: "results",
            sql: result.sql,
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rows.length,
            elapsed: 0,
            source: "ai",
          });
          return;
        }

        if (result.text && result.text.trim().length > 0) {
          panel.webview.postMessage({
            command: "results",
            sql: result.sql,
            columns: ["Answer"],
            rows: [[result.text.trim()]],
            rowCount: 1,
            elapsed: 0,
            source: "ai",
          });
          return;
        }

        // ── FIX 1: Instead of throwing, show a "no data" message ──────
        panel.webview.postMessage({
          command: "results",
          sql: result.sql || "",
          columns: ["Response"],
          rows: [["Query processed — no tabular data or text was returned. Check the backend logs for details."]],
          rowCount: 1,
          elapsed: 0,
          source: "ai",
        });

      } catch (e: any) { panel.webview.postMessage({ command: "queryError", message: e.message }); }
    }

    if (msg.command === "exportCSV") {
      const { columns, rows } = msg;
      const csv = [
        columns.join(","),
        ...rows.map((r: any[]) => r.map((v: any) => v == null ? "" : `"${String(v).replace(/"/g, '""')}"`).join(","))
      ].join("\n");
      const uri = await vscode.window.showSaveDialog({ filters: { "CSV": ["csv"] }, defaultUri: vscode.Uri.file("results.csv") });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, "utf8"));
        vscode.window.showInformationMessage("✅ Exported!");
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ASK AI sidebar button
// ─────────────────────────────────────────────────────────────
function openAskAIPanel(context: vscode.ExtensionContext) {
  const list = context.globalState.get<Connection[]>("pg.connections", []);
  const v = list.find(c => c.type === "vanna");
  if (!v) { vscode.window.showWarningMessage("Add a Vanna connection first using the + button."); return; }
  openQueryPanel(context, new TreeNode("conn", v.label, vscode.TreeItemCollapsibleState.None, v));
}

// ─────────────────────────────────────────────────────────────
// VANNA API
// ─────────────────────────────────────────────────────────────
async function askVannaAPI(
  baseUrl: string,
  query: string,
  dbType: DbType = "postgres",
): Promise<{ sql: string; text: string; columns?: string[]; rows?: any[][] }> {

  const res = await fetch(`${baseUrl}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, db_type: dbType }),
  });

  if (!res.ok) {
    throw new Error(`Vanna API error ${res.status} — Is python api.py running at ${baseUrl}?`);
  }

  const json = await res.json() as any;

  if (json.status !== "success") {
    throw new Error(`Vanna returned error: ${json.detail || JSON.stringify(json)}`);
  }

  const components: any[] = json.response || [];

  let sql = "";
  let text = "";
  let columns: string[] | undefined;
  let rows: any[][] | undefined;

  for (const comp of components) {
    const compType = (comp.type || "").toLowerCase();

    if (compType === "data") {
      const c = comp.content;

      if (c && Array.isArray(c.columns) && Array.isArray(c.rows) && c.columns.length > 0) {
        columns = c.columns as string[];
        if (c.rows.length > 0 && Array.isArray(c.rows[0])) {
          rows = c.rows as any[][];
        } else if (c.rows.length > 0 && typeof c.rows[0] === "object") {
          rows = c.rows.map((row: any) => (columns as string[]).map(col => row[col] ?? null));
        } else {
          rows = c.rows;
        }

      } else if (Array.isArray(c) && c.length > 0 && typeof c[0] === "object") {
        columns = Object.keys(c[0]);
        rows = c.map((row: any) => (columns as string[]).map(col => row[col] ?? null));
      }

    } else if (compType === "text" && typeof comp.content === "string" && comp.content.trim()) {
      text = comp.content.trim();

    } else if (compType === "sql" && typeof comp.content === "string" && !sql) {
      sql = comp.content.trim();

    } else if (compType === "uicomponent" && comp.content) {
      const rich = comp.content.rich_component;

      if (!rich) {
        const c = comp.content;
        if (typeof c === "string" && c.trim() && !text) {
          text = c.trim();
        } else if (typeof c === "object") {
          if (typeof c.text === "string" && c.text.trim() && !text) { text = c.text.trim(); }
          else if (typeof c.message === "string" && c.message.trim() && !text) { text = c.message.trim(); }
          else if (typeof c.content === "string" && c.content.trim() && !text) { text = c.content.trim(); }
        }
        continue;
      }

      const richType = (rich.type || "").toLowerCase();

      if (richType === "dataframe" && Array.isArray(rich.columns) && Array.isArray(rich.rows)) {
        columns = rich.columns as string[];
        if (rich.rows.length > 0 && Array.isArray(rich.rows[0])) {
          rows = rich.rows as any[][];
        } else {
          rows = rich.rows.map((row: any) => (columns as string[]).map(col => row[col] ?? null));
        }

      } else if (richType === "text" && typeof rich.content === "string" && rich.content.trim()) {
        text = rich.content.trim();

      } else if (richType === "status_card" && rich.metadata?.sql && !sql) {
        sql = rich.metadata.sql.trim();

      } else if (richType !== "") {
        if (Array.isArray(rich.rows) && Array.isArray(rich.columns) && !columns) {
          columns = rich.columns;
          rows = rich.rows.length > 0 && Array.isArray(rich.rows[0])
            ? rich.rows
            : rich.rows.map((row: any) => (columns as string[]).map(col => row[col] ?? null));
        } else if (typeof rich.content === "string" && rich.content.trim() && !text) {
          text = rich.content.trim();
        }
      }

    } else if (comp.content && !columns && !text) {
      if (typeof comp.content === "string" && comp.content.trim()) {
        text = comp.content.trim();
      } else if (typeof comp.content === "object") {
        const c = comp.content;
        if (Array.isArray(c) && c.length > 0 && typeof c[0] === "object") {
          columns = Object.keys(c[0]);
          rows = c.map((row: any) => (columns as string[]).map(col => row[col] ?? null));
        } else if (typeof c.text === "string") {
          text = c.text.trim();
        } else if (typeof c.content === "string") {
          text = c.content.trim();
        }
      }
    }
  }

  return { sql, text, columns, rows };
}

// ─────────────────────────────────────────────────────────────
// HTML — ADD FORM  (NEXT-LEVEL UI)
// ─────────────────────────────────────────────────────────────
function getAddFormHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
<style>
:root{
  --add-accent:#6366f1;
  --add-accent-glow:rgba(99,102,241,0.18);
  --add-accent-dim:rgba(99,102,241,0.10);
  --add-accent-border:rgba(99,102,241,0.30);
  --add-gradient:linear-gradient(135deg,#6366f1,#8b5cf6,#3b82f6);
  --add-gradient-bar:linear-gradient(180deg,#6366f1 0%,#8b5cf6 50%,#3b82f6 100%);
  --add-success:#10b981;
  --add-error:#f87171;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  color:var(--vscode-foreground);
  background:var(--vscode-editor-background);
  min-height:100vh;
}
.layout{display:flex;min-height:100vh}
.stripe{
  width:5px;
  flex-shrink:0;
  background:var(--add-gradient-bar);
  box-shadow:2px 0 12px rgba(99,102,241,0.25);
}
.content{flex:1;padding:36px 32px;max-width:520px}

/* ─── eyebrow ─── */
.eyebrow{
  font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);opacity:0.45;
  margin-bottom:12px;display:flex;align-items:center;gap:10px;
}
.eyebrow::after{content:'';flex:1;height:1px;background:var(--vscode-editorGroup-border)}

/* ─── title ─── */
.head-row{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.head-icon{
  width:38px;height:38px;border-radius:10px;flex-shrink:0;
  background:var(--add-gradient);display:flex;align-items:center;justify-content:center;
  font-size:18px;box-shadow:0 4px 14px rgba(99,102,241,0.35);
}
h2{font-size:21px;font-weight:700;letter-spacing:-0.5px;color:var(--vscode-foreground)}
.sub{font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.65;margin-bottom:30px;margin-left:50px}

/* ─── pill tabs ─── */
.tabs{
  display:flex;gap:6px;margin-bottom:28px;
  background:rgba(255,255,255,0.03);
  border:1px solid var(--vscode-editorGroup-border);
  border-radius:10px;padding:5px;
}
.tab{
  flex:1;padding:9px 14px;text-align:center;cursor:pointer;
  font-size:12px;font-weight:700;border:none;
  background:transparent;color:var(--vscode-descriptionForeground);
  transition:all 0.18s ease;letter-spacing:0.3px;
  border-radius:7px;
}
.tab.active{
  background:var(--add-accent-dim);
  color:var(--add-accent);
  box-shadow:inset 0 0 0 1px var(--add-accent-border);
}
.tab:hover:not(.active){background:rgba(255,255,255,0.04);color:var(--vscode-foreground)}

/* ─── forms ─── */
.form{display:none;animation:fadein 0.22s ease}.form.active{display:block}
@keyframes fadein{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}

/* section header */
.section-header{display:flex;align-items:center;gap:12px;margin-bottom:22px;
  padding:14px 16px;background:rgba(255,255,255,0.025);border:1px solid var(--vscode-editorGroup-border);border-radius:10px;
}
.section-icon{
  width:36px;height:36px;border-radius:9px;
  display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;
}
.section-icon.vanna{background:var(--add-accent-dim);border:1px solid var(--add-accent-border)}
.section-icon.pg{background:rgba(96,165,250,0.10);border:1px solid rgba(96,165,250,0.25)}
.section-title{font-size:13px;font-weight:700;color:var(--vscode-foreground)}
.section-desc{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}

/* ─── fields ─── */
.field{margin-bottom:16px}
label{
  display:block;font-size:10px;font-weight:700;letter-spacing:0.7px;
  text-transform:uppercase;color:var(--vscode-descriptionForeground);
  opacity:0.7;margin-bottom:6px;
}
input,select{
  width:100%;padding:10px 13px;
  background:var(--vscode-input-background);color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,rgba(255,255,255,0.08));
  border-radius:7px;font-size:13px;
  transition:border-color 0.15s,box-shadow 0.15s;
  font-family:var(--vscode-font-family);
}
input:focus,select:focus{
  outline:none;
  border-color:var(--add-accent);
  box-shadow:0 0 0 3px var(--add-accent-glow);
}
input::placeholder{color:var(--vscode-input-placeholderForeground);opacity:0.4}
select{cursor:pointer;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23888' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 12px center;
  padding-right:32px;
}
.row{display:flex;gap:10px}.row .field{flex:1}.port{flex:0 0 95px!important}

/* ─── primary button ─── */
.btn-row{display:flex;align-items:center;gap:10px;margin-top:20px}
button.primary{
  padding:10px 22px;
  background:var(--add-gradient);
  color:#fff;border:none;border-radius:7px;cursor:pointer;
  font-size:12px;font-weight:700;letter-spacing:0.4px;
  transition:opacity 0.15s,transform 0.1s,box-shadow 0.15s;
  display:inline-flex;align-items:center;gap:7px;
  box-shadow:0 2px 10px rgba(99,102,241,0.4);
}
button.primary:hover{opacity:0.88;box-shadow:0 4px 16px rgba(99,102,241,0.5)}
button.primary:active{transform:scale(0.97)}

/* ─── status ─── */
#st{margin-top:16px;font-size:12px;min-height:22px;padding:8px 13px;border-radius:7px;line-height:1.5;transition:all 0.2s}
#st:not(:empty){background:rgba(255,255,255,0.035);border:1px solid var(--vscode-editorGroup-border)}
.err{color:var(--add-error)!important;border-color:rgba(248,113,113,0.3)!important;background:rgba(248,113,113,0.06)!important}
.ok{color:var(--add-success)!important;border-color:rgba(16,185,129,0.3)!important;background:rgba(16,185,129,0.06)!important}

/* ─── tip box ─── */
.tip{
  margin-top:22px;border-radius:9px;
  border:1px solid rgba(16,185,129,0.22);
  overflow:hidden;
}
.tip-header{
  display:flex;align-items:center;gap:7px;
  padding:9px 14px;
  background:rgba(16,185,129,0.07);
  border-bottom:1px solid rgba(16,185,129,0.15);
  font-size:10px;font-weight:700;letter-spacing:0.6px;
  text-transform:uppercase;color:#34d399;
}
.tip-body{padding:12px 14px;font-size:11.5px;color:var(--vscode-descriptionForeground);line-height:2}
code{
  font-family:'Cascadia Code','Fira Code',monospace;font-size:11px;
  background:rgba(255,255,255,0.07);padding:2px 8px;
  border-radius:4px;border:1px solid rgba(255,255,255,0.07);color:#a5f3fc;
}
</style></head><body>
<div class="layout">
  <div class="stripe"></div>
  <div class="content">
    <div class="eyebrow">PG Explorer · New Connection</div>
    <div class="head-row">
      <div class="head-icon">🔌</div>
      <h2>Add Connection</h2>
    </div>
    <div class="sub">Connect to a Vanna AI backend or a direct PostgreSQL database.</div>

    <div class="tabs">
      <button class="tab active" onclick="show('vanna')">⚡ Vanna AI</button>
      <button class="tab" onclick="show('pg')">🐘 PostgreSQL</button>
    </div>

    <!-- ── Vanna Form ── -->
    <div class="form active" id="fV">
      <div class="section-header">
        <div class="section-icon vanna">⚡</div>
        <div>
          <div class="section-title">Vanna AI Backend</div>
          <div class="section-desc">Natural language → SQL, powered by Vanna</div>
        </div>
      </div>
      <div class="field"><label>Connection Name</label><input id="vl" placeholder="e.g. Chinook via Vanna"/></div>
      <div class="field"><label>Backend URL</label><input id="vu" value="http://localhost:8000"/></div>
      <div class="field"><label>Database Type</label>
        <select id="vd">
          <option value="postgres" selected>🐘 PostgreSQL</option>
          <option value="mysql">🐬 MySQL</option>
          <option value="oracle">🔶 Oracle</option>
        </select>
      </div>
      <div class="btn-row"><button class="primary" onclick="sv()">⚡ Connect to Vanna</button></div>
      <div class="tip">
        <div class="tip-header">💡 Prerequisites</div>
        <div class="tip-body"><code>cd sample_new_vanna</code><br/><code>python api.py</code></div>
      </div>
    </div>

    <!-- ── PostgreSQL Form ── -->
    <div class="form" id="fP">
      <div class="section-header">
        <div class="section-icon pg">🐘</div>
        <div>
          <div class="section-title">Direct PostgreSQL</div>
          <div class="section-desc">Connect with host / port credentials</div>
        </div>
      </div>
      <div class="field"><label>Connection Name</label><input id="pl" placeholder="e.g. My Production DB"/></div>
      <div class="row">
        <div class="field"><label>Host</label><input id="ph" value="localhost"/></div>
        <div class="field port"><label>Port</label><input id="pp" value="5432"/></div>
      </div>
      <div class="field"><label>Database</label><input id="pd" placeholder="chinook"/></div>
      <div class="row">
        <div class="field"><label>Username</label><input id="pu" placeholder="postgres"/></div>
        <div class="field"><label>Password</label><input id="pw" type="password" placeholder="••••••••"/></div>
      </div>
      <div class="btn-row"><button class="primary" onclick="sp()">🔌 Test &amp; Connect</button></div>
    </div>

    <div id="st"></div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
const btns = document.querySelectorAll('.tab');
function show(t) {
  btns.forEach((b, i) => b.classList.toggle('active', (t==='vanna'&&i===0)||(t==='pg'&&i===1)));
  document.getElementById('fV').classList.toggle('active', t==='vanna');
  document.getElementById('fP').classList.toggle('active', t==='pg');
  document.getElementById('st').textContent = '';
}
function sv() {
  vscode.postMessage({ command: 'saveVanna', data: {
    label: document.getElementById('vl').value,
    vannaUrl: document.getElementById('vu').value,
    dbType: document.getElementById('vd').value,
  }});
}
function sp() {
  vscode.postMessage({ command: 'savePostgres', data: {
    label: document.getElementById('pl').value,
    host: document.getElementById('ph').value,
    port: document.getElementById('pp').value,
    database: document.getElementById('pd').value,
    user: document.getElementById('pu').value,
    password: document.getElementById('pw').value,
  }});
}
window.addEventListener('message', e => {
  const m = e.data;
  if (m.command === 'status') {
    const el = document.getElementById('st');
    el.textContent = m.text;
    el.className = m.error ? 'err' : m.success ? 'ok' : '';
  }
});
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
// HTML — QUERY RUNNER  (NEXT-LEVEL UI)
// ─────────────────────────────────────────────────────────────
function getQueryRunnerHtml(
  label: string,
  connType: string,
  fontSize: number,
  queryLimit: number,
  vannaUrl?: string,
  dbLabel?: string,
): string {
  const iv = connType === "vanna";
  const badgeText = iv ? (dbLabel || "⚡ Vanna AI") : "🐘 PostgreSQL";

  // DB-specific theme tokens
  const rawDb = (dbLabel || "").toLowerCase();
  let accentColor = "#6366f1";   // PostgreSQL → indigo
  let accentGlow = "rgba(99,102,241,0.18)";
  let accentDim = "rgba(99,102,241,0.10)";
  let accentBorder = "rgba(99,102,241,0.28)";
  let gradient = "linear-gradient(135deg,#6366f1,#4f46e5)";
  let gradientSoft = "linear-gradient(135deg,rgba(99,102,241,0.18),rgba(79,70,229,0.10))";
  if (rawDb.includes("mysql")) {
    accentColor = "#10b981";  // MySQL → emerald
    accentGlow = "rgba(16,185,129,0.18)";
    accentDim = "rgba(16,185,129,0.10)";
    accentBorder = "rgba(16,185,129,0.28)";
    gradient = "linear-gradient(135deg,#10b981,#059669)";
    gradientSoft = "linear-gradient(135deg,rgba(16,185,129,0.18),rgba(5,150,105,0.10))";
  }
  if (rawDb.includes("oracle")) {
    accentColor = "#ef4444";  // Oracle → red
    accentGlow = "rgba(239,68,68,0.18)";
    accentDim = "rgba(239,68,68,0.10)";
    accentBorder = "rgba(239,68,68,0.28)";
    gradient = "linear-gradient(135deg,#ef4444,#dc2626)";
    gradientSoft = "linear-gradient(135deg,rgba(239,68,68,0.18),rgba(220,38,38,0.10))";
  }

  const hostDisplay = vannaUrl ? vannaUrl.replace(/^https?:\/\//, "") : "direct";


  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${vannaUrl || 'http://localhost:8000'} http://localhost:8000;"/>
<style>
:root{
  --ac:${accentColor};
  --ac-glow:${accentGlow};
  --ac-dim:${accentDim};
  --ac-border:${accentBorder};
  --ac-grad:${gradient};
  --ac-grad-soft:${gradientSoft};
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:var(--vscode-font-family);
  font-size:${fontSize}px;
  color:var(--vscode-foreground);
  background:var(--vscode-editor-background);
  display:flex;flex-direction:column;height:100vh;overflow:hidden;
}

/* ══ HEADER ══ */
.hdr{
  display:flex;align-items:center;flex-shrink:0;height:48px;
  background:var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom:1px solid var(--vscode-editorGroup-border);
  overflow:hidden;
}
.hdr-left{display:flex;align-items:center;gap:10px;padding:0 16px;flex:1;min-width:0}
.status-dot{
  width:8px;height:8px;border-radius:50%;background:var(--ac);flex-shrink:0;
  box-shadow:0 0 0 2px var(--ac-dim),0 0 10px var(--ac);
  animation:pulse-dot 2.5s ease infinite;
}
@keyframes pulse-dot{
  0%,100%{box-shadow:0 0 0 2px var(--ac-dim),0 0 8px var(--ac)}
  50%{box-shadow:0 0 0 4px var(--ac-dim),0 0 16px var(--ac)}
}
.conn-label{
  font-size:13px;font-weight:700;color:var(--vscode-foreground);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.conn-host{
  font-size:10px;color:var(--vscode-descriptionForeground);
  opacity:0.4;white-space:nowrap;flex-shrink:0;
  font-family:'Cascadia Code','Fira Code',monospace;
  background:rgba(255,255,255,0.05);padding:2px 7px;
  border-radius:4px;border:1px solid rgba(255,255,255,0.07);
}
.hdr-right{display:flex;align-items:center;gap:10px;padding:0 16px;flex-shrink:0}
.db-badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:4px 12px;border-radius:20px;
  font-size:10px;font-weight:700;letter-spacing:0.5px;
  border:1px solid var(--ac-border);color:var(--ac);
  background:var(--ac-dim);
  box-shadow:0 0 10px var(--ac-glow);
}
.conn-status{
  font-size:10px;font-weight:600;color:#4ade80;
  letter-spacing:0.3px;display:flex;align-items:center;gap:5px;
}
.conn-status::before{content:'●';font-size:7px;animation:blink 2s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}

/* ══ TABS ══ */
.tabs{
  display:flex;align-items:stretch;flex-shrink:0;
  background:var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom:1px solid var(--vscode-editorGroup-border);
  padding:0 14px;gap:0;
}
.tab{
  display:flex;align-items:center;gap:7px;padding:0 20px;height:40px;
  font-size:12px;cursor:pointer;border:none;
  border-bottom:2px solid transparent;
  color:var(--vscode-descriptionForeground);background:none;
  font-weight:600;letter-spacing:0.2px;margin-bottom:-1px;
  transition:color 0.12s,border-color 0.15s;
}
.tab.active{color:var(--vscode-foreground);border-bottom-color:var(--ac)}
.tab:hover:not(.active){color:var(--vscode-foreground);background:rgba(255,255,255,0.02)}

/* ══ PANELS ══ */
.panel{display:none;flex-direction:column;flex-shrink:0}.panel.active{display:flex}

/* ══ SQL EDITOR ══ */
.editor-shell{padding:14px 16px 10px;display:flex;flex-direction:column}
.editor-topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.editor-label{
  font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;
  color:var(--ac);opacity:0.75;display:flex;align-items:center;gap:6px;
}
.editor-label::before{content:'';display:block;width:3px;height:12px;border-radius:2px;background:var(--ac);opacity:0.7}
.btn-clear{
  font-size:10px;padding:3px 10px;background:transparent;
  color:var(--vscode-descriptionForeground);
  border:1px solid var(--vscode-editorGroup-border);
  border-radius:5px;cursor:pointer;font-weight:600;
  transition:all 0.12s;opacity:0.55;
}
.btn-clear:hover{opacity:1;color:var(--vscode-foreground);background:rgba(255,255,255,0.05)}
.editor-frame{
  position:relative;
  border:1px solid var(--vscode-input-border,rgba(255,255,255,0.08));
  border-radius:9px;overflow:hidden;
  transition:border-color 0.15s,box-shadow 0.15s;
}
.editor-frame:focus-within{border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-glow)}
.editor-gutter{
  position:absolute;left:0;top:0;bottom:0;width:36px;
  background:rgba(0,0,0,0.2);border-right:1px solid rgba(255,255,255,0.05);
  display:flex;flex-direction:column;padding-top:12px;
  pointer-events:none;z-index:1;
}
.editor-gutter span{
  font-size:10px;line-height:${fontSize * 1.55}px;
  text-align:right;padding-right:8px;
  color:var(--ac);opacity:0.3;font-family:monospace;
  display:block;height:${fontSize * 1.55}px;
}
textarea{
  width:100%;height:130px;min-height:90px;
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:none;outline:none;
  padding:12px 14px 12px 48px;
  font-family:'Cascadia Code','Fira Code','Courier New',monospace;
  font-size:${fontSize}px;resize:vertical;line-height:1.55;display:block;
}

/* ══ ASK AI ══ */
.ai-shell{padding:18px 16px 14px}
.ai-header-row{display:flex;align-items:flex-start;gap:13px;margin-bottom:16px}
.ai-avatar{
  width:42px;height:42px;border-radius:12px;flex-shrink:0;
  background:var(--ac-grad);
  display:flex;align-items:center;justify-content:center;font-size:18px;
  box-shadow:0 4px 16px var(--ac-glow);
}
.ai-title{font-size:14px;font-weight:700;color:var(--vscode-foreground);margin-bottom:3px}
.ai-sub{font-size:11.5px;color:var(--vscode-descriptionForeground);line-height:1.55;opacity:0.7}
.ai-input-row{display:flex;align-items:center;gap:8px}
.ai-input-wrap{flex:1;position:relative}
.ai{
  width:100%;padding:12px 48px 12px 18px;
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,rgba(255,255,255,0.08));
  border-radius:26px;font-size:13px;
  font-family:var(--vscode-font-family);
  transition:border-color 0.15s,box-shadow 0.15s;
}
.ai:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--ac-glow)}
.ai::placeholder{color:var(--vscode-input-placeholderForeground);opacity:0.4}
.ai-send-btn{
  position:absolute;right:8px;top:50%;transform:translateY(-50%);
  width:30px;height:30px;border-radius:50%;
  background:var(--ac-grad);border:none;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  font-size:11px;color:#fff;font-weight:800;
  box-shadow:0 2px 8px var(--ac-glow);
  transition:transform 0.12s,box-shadow 0.12s;
}
.ai-send-btn:hover{transform:translateY(-50%) scale(1.1);box-shadow:0 4px 14px var(--ac-glow)}
.ai-hint-row{
  margin-top:9px;display:flex;align-items:center;gap:6px;
  font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.5;
}
.kbd{
  font-family:monospace;font-size:9px;background:rgba(255,255,255,0.07);
  border:1px solid rgba(255,255,255,0.12);border-bottom:2px solid rgba(255,255,255,0.18);
  border-radius:4px;padding:2px 6px;color:var(--vscode-foreground);opacity:0.8;
}

/* Not-vanna */
.na-shell{padding:20px 16px}
.na-card{
  background:rgba(255,255,255,0.025);
  border:1px solid var(--vscode-editorGroup-border);
  border-radius:12px;padding:22px;display:flex;gap:14px;align-items:flex-start;
}
.na-icon{font-size:24px;flex-shrink:0;margin-top:1px}
.na-title{font-size:13px;font-weight:700;margin-bottom:10px}
.na-steps{font-size:12px;color:var(--vscode-descriptionForeground);line-height:2.3}
.step-num{
  display:inline-flex;align-items:center;justify-content:center;
  width:20px;height:20px;border-radius:50%;
  background:var(--ac-dim);border:1px solid var(--ac-border);
  font-size:9px;font-weight:700;margin-right:6px;color:var(--ac);
}
.na-steps strong{color:var(--vscode-foreground)}

/* ══ ACTION BAR ══ */
.acts{
  display:flex;gap:8px;padding:10px 16px;align-items:center;flex-shrink:0;
  background:var(--vscode-editorGroupHeader-tabsBackground);
  border-top:1px solid var(--vscode-editorGroup-border);
}
.btn-run{
  display:inline-flex;align-items:center;gap:8px;padding:8px 20px;
  background:var(--ac-grad);
  color:#fff;border:none;border-radius:7px;cursor:pointer;
  font-weight:700;font-size:12px;letter-spacing:0.3px;
  transition:opacity 0.15s,transform 0.1s,box-shadow 0.15s;
  box-shadow:0 2px 10px var(--ac-glow);
}
.btn-run:hover{opacity:0.88;box-shadow:0 4px 16px var(--ac-glow)}
.btn-run:active{transform:scale(0.97)}
.btn-exp{
  display:none;padding:7px 14px;background:transparent;
  color:var(--vscode-descriptionForeground);
  border:1px solid var(--vscode-editorGroup-border);
  border-radius:7px;cursor:pointer;font-size:11px;font-weight:600;
  align-items:center;gap:6px;transition:all 0.15s;
}
.btn-exp.show{display:inline-flex}
.btn-exp:hover{background:rgba(255,255,255,0.05);color:var(--vscode-foreground);border-color:rgba(255,255,255,0.2)}
.acts-hint{flex:1;text-align:right;font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.4;letter-spacing:0.2px}

/* ══ STATUS BAR ══ */
.statusbar{
  display:flex;align-items:center;gap:8px;padding:4px 16px;flex-shrink:0;
  background:var(--vscode-editorGroupHeader-tabsBackground);
  border-bottom:1px solid var(--vscode-editorGroup-border);
  min-height:24px;font-size:10px;
  color:var(--vscode-descriptionForeground);letter-spacing:0.2px;
}
.sb-dot{width:5px;height:5px;border-radius:50%;background:var(--ac);opacity:0.5;flex-shrink:0}

/* ══ SQL PREVIEW CARD ══ */
.sql-card{
  margin:10px 14px 0;border:1px solid var(--ac-border);
  border-radius:9px;overflow:hidden;flex-shrink:0;display:none;
  animation:card-in 0.2s ease;
}
.sql-card.show{display:block}
@keyframes card-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.sql-card-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:7px 13px;background:var(--ac-dim);
  cursor:pointer;user-select:none;
}
.sql-card-title{
  display:flex;align-items:center;gap:7px;
  font-size:10px;font-weight:700;letter-spacing:0.6px;
  text-transform:uppercase;color:var(--ac);
}
.sql-card-toggle{font-size:9px;color:var(--vscode-descriptionForeground);opacity:0.6;transition:transform 0.2s}
.sql-card.collapsed .sql-card-toggle{transform:rotate(-90deg)}
.sql-card-body{
  padding:11px 14px;font-family:'Cascadia Code','Fira Code',monospace;
  font-size:11px;color:var(--vscode-foreground);line-height:1.65;
  white-space:pre-wrap;word-break:break-all;
  background:rgba(0,0,0,0.15);
  border-top:1px solid var(--ac-border);max-height:130px;overflow:auto;
}
.sql-card.collapsed .sql-card-body{display:none}

/* ══ RESULTS ══ */
.res{flex:1;overflow:auto;padding-bottom:8px}
.state-empty{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;min-height:140px;padding:32px;text-align:center;
  color:var(--vscode-descriptionForeground);
}
.empty-icon{font-size:34px;margin-bottom:14px;opacity:0.25}
.empty-title{font-size:13px;font-weight:600;margin-bottom:5px;opacity:0.5}
.empty-sub{font-size:11px;opacity:0.3;line-height:1.65}
.state-loading{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  height:100%;min-height:140px;padding:32px;text-align:center;
  color:var(--vscode-descriptionForeground);animation:fadein 0.2s ease;
}
.robot-face{font-size:30px;margin-bottom:12px;animation:bob 1.5s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.loading-label{font-size:13px;font-weight:600;margin-bottom:14px;color:var(--vscode-foreground);opacity:0.7}
.loading-bar{width:200px;height:3px;border-radius:2px;background:rgba(255,255,255,0.07);overflow:hidden}
.loading-bar-fill{
  height:100%;border-radius:2px;
  background:linear-gradient(90deg,transparent,var(--ac),transparent);
  background-size:200% 100%;animation:shimmer 1.4s ease infinite;
}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* Result cards */
.result-cards{padding:12px 14px;display:flex;flex-direction:column;gap:12px;animation:fadein 0.3s ease}
@keyframes fadein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.card{border:1px solid var(--vscode-editorGroup-border);border-radius:11px;overflow:hidden}
.card-header{
  display:flex;align-items:center;gap:8px;padding:9px 14px;
  background:rgba(255,255,255,0.02);
  border-bottom:1px solid var(--vscode-editorGroup-border);
}
.card-icon{font-size:14px}
.card-title{font-size:11px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.card-meta{margin-left:auto;font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.5}

/* Answer card */
.card-answer{border-left:3px solid #10b981}
.card-answer .card-header{background:rgba(16,185,129,0.06);border-bottom-color:rgba(16,185,129,0.15)}
.card-answer .card-title{color:#34d399}
.card-answer .card-body{padding:16px 18px;font-size:${fontSize}px;line-height:1.8;color:var(--vscode-foreground)}

/* Table card */
.card-table{border-left:3px solid var(--ac)}
.card-table .card-header{background:var(--ac-dim);border-bottom-color:var(--ac-border)}
.card-table .card-title{color:var(--ac)}
.card-table .card-body{padding:0;overflow:auto;max-height:360px}

table{border-collapse:collapse;width:100%;font-size:${fontSize - 1}px}
thead th{
  background:var(--vscode-editorGroupHeader-tabsBackground);
  padding:7px 14px;text-align:left;font-size:10px;font-weight:700;
  letter-spacing:0.6px;text-transform:uppercase;
  color:var(--ac);opacity:0.8;
  border-bottom:1px solid var(--vscode-editorGroup-border);
  position:sticky;top:0;white-space:nowrap;z-index:1;
}
tbody tr:nth-child(even){background:rgba(255,255,255,0.018)}
tbody tr:hover{background:var(--vscode-list-hoverBackground)}
tbody tr{transition:background 0.1s}
td{
  padding:6px 14px;border-bottom:1px solid rgba(255,255,255,0.04);
  white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;
  font-size:${fontSize - 1}px;
}
tbody tr:last-child td{border-bottom:none}
.null-val{color:var(--vscode-descriptionForeground);font-style:italic;opacity:0.4}

/* Error card */
.card-error{border-left:3px solid #ef4444}
.card-error .card-header{background:rgba(239,68,68,0.07);border-bottom-color:rgba(239,68,68,0.2)}
.card-error .card-title{color:#f87171}
.card-error .card-body{padding:14px 16px;font-family:monospace;font-size:11.5px;color:#f87171;white-space:pre-wrap;line-height:1.65}
</style></head><body>

<!-- ══ HEADER ══ -->
<div class="hdr">
  <div class="hdr-left">
    <div class="status-dot"></div>
    <div class="conn-label">${escHtml(label)}</div>
    <div class="conn-host">${escHtml(hostDisplay)}</div>
  </div>
  <div class="hdr-right">
    <div class="db-badge">${escHtml(badgeText)}</div>
    <div class="conn-status">Connected</div>
  </div>
</div>

<!-- ══ TABS ══ -->
<div class="tabs">
  <button class="tab active" id="t1" onclick="sw('sql')">✏️ SQL Editor</button>
  <button class="tab" id="t2" onclick="sw('ai')">✨ Ask AI</button>
</div>

<!-- ══ SQL EDITOR PANEL ══ -->
<div class="panel active" id="p1">
  <div class="editor-shell">
    <div class="editor-topbar">
      <div class="editor-label">Query Editor</div>
      <button class="btn-clear" onclick="document.getElementById('sq').value=''">🧹 Clear</button>
    </div>
    <div class="editor-frame">
      <div class="editor-gutter" id="gutter">
        <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
      </div>
      <textarea id="sq" spellcheck="false">SELECT * FROM &lt;table&gt; LIMIT ${queryLimit};</textarea>
    </div>
  </div>
</div>

<!-- ══ ASK AI PANEL ══ -->
<div class="panel" id="p2">
  ${iv
      ? `<div class="ai-shell">
        <div class="ai-header-row">
          <div class="ai-avatar">✨</div>
          <div>
            <div class="ai-title">Ask in plain English</div>
            <div class="ai-sub">Vanna translates your question into SQL and fetches real data from your database.</div>
          </div>
        </div>
        <div class="ai-input-row">
          <div class="ai-input-wrap">
            <input class="ai" id="qi" type="text" placeholder="Ask a question about your data…" autocomplete="off"/>
            <button class="ai-send-btn" onclick="go()">▶</button>
          </div>
        </div>
        <div class="ai-hint-row">
          <span class="kbd">Enter</span>
          <span>to send &nbsp;·&nbsp; Ask anything about your data</span>
        </div>
      </div>`
      : `<div class="na-shell">
        <div class="na-card">
          <div class="na-icon">⚡</div>
          <div>
            <div class="na-title">Ask AI requires a Vanna connection</div>
            <div class="na-steps">
              <span class="step-num">1</span> Click <strong>+</strong> in the sidebar<br/>
              <span class="step-num">2</span> Select the <strong>⚡ Vanna AI</strong> tab<br/>
              <span class="step-num">3</span> Enter your Vanna URL and connect
            </div>
          </div>
        </div>
      </div>`
    }
</div>

<!-- ══ ACTION BAR ══ -->
<div class="acts">
  <button class="btn-run" id="rb">▶ Run Query</button>
  <button class="btn-exp" id="eb">↓ Export CSV</button>
  <div class="acts-hint" id="ht">Ctrl+Enter to run</div>
</div>

<!-- ══ STATUS BAR ══ -->
<div class="statusbar" id="sb"><div class="sb-dot"></div><span>Ready</span></div>

<!-- ══ SQL PREVIEW CARD ══ -->
<div class="sql-card" id="pl">
  <div class="sql-card-header" onclick="toggleSqlCard()">
    <div class="sql-card-title">🗒 Generated SQL</div>
    <div class="sql-card-toggle">▼</div>
  </div>
  <div class="sql-card-body" id="pt"></div>
</div>

<!-- ══ RESULTS ══ -->
<div class="res" id="rs">
  <div class="state-empty">
    <div class="empty-icon">📊</div>
    <div class="empty-title">No results yet</div>
    <div class="empty-sub">Run a query or ask AI to see results here.</div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
const IV = ${iv};
let mode = 'sql', CS = [], RS = [];
const SQ = document.getElementById('sq'), QI = document.getElementById('qi');
const RB = document.getElementById('rb'), EB = document.getElementById('eb');
const SB = document.getElementById('sb'), RS_el = document.getElementById('rs');
const PL = document.getElementById('pl'), PT = document.getElementById('pt'), HT = document.getElementById('ht');

function sw(t) {
  mode = t;
  document.getElementById('t1').classList.toggle('active', t === 'sql');
  document.getElementById('t2').classList.toggle('active', t === 'ai');
  document.getElementById('p1').classList.toggle('active', t === 'sql');
  document.getElementById('p2').classList.toggle('active', t === 'ai');
  RB.textContent = t === 'sql' ? '▶ Run Query' : '✨ Ask AI';
  HT.textContent = t === 'sql' ? 'Ctrl+Enter to run' : 'Enter to ask';
  if (t === 'ai' && QI) QI.focus(); else SQ.focus();
}

function go() {
  if (mode === 'sql') {
    const sql = SQ.value.trim(); if (!sql) return;
    hp(); EB.classList.remove('show');
    setSb('⏳ Running...');
    showLoading('Executing query');
    vscode.postMessage({ command: 'runSQL', sql });
  } else {
    if (!IV) return;
    const q = QI.value.trim(); if (!q) return;
    hp(); EB.classList.remove('show');
    setSb('⏳ Vanna AI is thinking...');
    showLoading('🤖 Thinking…');
    vscode.postMessage({ command: 'askAI', question: q });
  }
}

function setSb(txt) {
  SB.innerHTML = '<div class="sb-dot"></div><span>' + x(txt) + '</span>';
}

function showLoading(label) {
  RS_el.innerHTML =
    '<div class="state-loading">' +
    '<div class="robot-face">🤖</div>' +
    '<div class="loading-label">' + x(label) + '</div>' +
    '<div class="loading-bar"><div class="loading-bar-fill"></div></div>' +
    '</div>';
}

function toggleSqlCard() { PL.classList.toggle('collapsed'); }

RB.addEventListener('click', go);
SQ.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go(); } });
if (QI) QI.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
EB.addEventListener('click', () => vscode.postMessage({ command: 'exportCSV', columns: CS, rows: RS }));

function hp() { PL.classList.remove('show'); }
function sp(s) { PT.textContent = s; PL.classList.add('show'); PL.classList.remove('collapsed'); }

window.addEventListener('message', e => {
  const m = e.data;
  if (m.command === 'loading')      { setSb('⏳ Running...'); showLoading('Executing query'); }
  if (m.command === 'aiLoading')    { setSb('⏳ Vanna AI is thinking...'); showLoading('🤖 Thinking…'); }
  if (m.command === 'sqlGenerated') { setSb('⏳ SQL ready — fetching results...'); sp(m.sql); }

  if (m.command === 'results') {
    CS = m.columns || []; RS = m.rows || [];
    const n = RS.length;
    const src = m.source === 'ai' ? ' · Vanna AI' : '';
    setSb('✅ ' + n + ' ' + (n === 1 ? 'row' : 'rows') + (m.elapsed ? ' · ' + m.elapsed + 'ms' : '') + src);
    if (m.sql && m.source === 'ai') sp(m.sql);
    if (n > 0) EB.classList.add('show');

    if (n === 0) {
      RS_el.innerHTML =
        '<div class="state-empty">' +
        '<div class="empty-icon">🔍</div>' +
        '<div class="empty-title">No rows returned</div>' +
        '<div class="empty-sub">The query executed successfully but returned 0 rows.</div>' +
        '</div>';
      return;
    }

    if (CS.length === 1 && CS[0] === 'Answer' && n === 1) {
      RS_el.innerHTML =
        '<div class="result-cards"><div class="card card-answer">' +
        '<div class="card-header"><span class="card-icon">💡</span><span class="card-title">Answer</span></div>' +
        '<div class="card-body">' + x(RS[0][0]) + '</div>' +
        '</div></div>';
      return;
    }

    if (CS.length === 1 && CS[0] === 'Response' && n === 1) {
      RS_el.innerHTML =
        '<div class="result-cards"><div class="card card-answer">' +
        '<div class="card-header"><span class="card-icon">💡</span><span class="card-title">Response</span></div>' +
        '<div class="card-body">' + x(RS[0][0]) + '</div>' +
        '</div></div>';
      return;
    }

    let thead = '<thead><tr>' + CS.map(c => '<th>' + x(c) + '</th>').join('') + '</tr></thead>';
    let tbody = '<tbody>';
    RS.forEach(r => {
      tbody += '<tr>';
      (Array.isArray(r) ? r : CS.map(c => r[c])).forEach(v => {
        tbody += v == null
          ? '<td><span class="null-val">NULL</span></td>'
          : '<td title="' + x(String(v)) + '">' + x(String(v)) + '</td>';
      });
      tbody += '</tr>';
    });
    tbody += '</tbody>';

    RS_el.innerHTML =
      '<div class="result-cards"><div class="card card-table">' +
      '<div class="card-header"><span class="card-icon">📊</span><span class="card-title">Query Results</span>' +
      '<span class="card-meta">' + n + ' row' + (n !== 1 ? 's' : '') + '</span></div>' +
      '<div class="card-body"><table>' + thead + tbody + '</table></div>' +
      '</div></div>';
  }

  if (m.command === 'queryError') {
    setSb('❌ Error');
    RS_el.innerHTML =
      '<div class="result-cards"><div class="card card-error">' +
      '<div class="card-header"><span class="card-icon">⚠️</span><span class="card-title">Error</span></div>' +
      '<div class="card-body">' + x(m.message) + '</div>' +
      '</div></div>';
    EB.classList.remove('show');
  }
});

function x(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body></html>`;
}
// ─────────────────────────────────────────────────────────────
// SETTINGS  (NEXT-LEVEL UI)
// ─────────────────────────────────────────────────────────────
function getSettingsHtml(s: AppSettings): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);min-height:100vh}
.layout{display:flex;min-height:100vh}
.stripe{width:4px;flex-shrink:0;background:linear-gradient(180deg,#3b82f6,#8b5cf6)}
.content{flex:1;padding:32px 28px;max-width:420px}
.eyebrow{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--vscode-descriptionForeground);opacity:0.5;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.eyebrow::after{content:'';flex:1;height:1px;background:var(--vscode-editorGroup-border)}
h2{font-size:20px;font-weight:700;letter-spacing:-0.5px;margin-bottom:24px}
.section-label{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--vscode-descriptionForeground);opacity:0.55;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--vscode-editorGroup-border)}
.f{margin-bottom:18px}
label{display:block;font-size:10px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:var(--vscode-descriptionForeground);opacity:0.7;margin-bottom:5px}
input{width:100%;padding:9px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,rgba(255,255,255,0.08));border-radius:6px;font-size:13px;transition:border-color 0.15s,box-shadow 0.15s}
input:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,0.15)}
.desc{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:5px;opacity:0.5;line-height:1.5}
button{padding:9px 22px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;margin-top:8px;letter-spacing:0.3px;box-shadow:0 1px 6px rgba(29,78,216,0.35);transition:background 0.15s,transform 0.1s}
button:hover{background:#2563eb}
button:active{transform:scale(0.98)}
#sv{margin-top:14px;font-size:12px;min-height:20px;padding:8px 12px;border-radius:6px;transition:all 0.2s}
#sv:not(:empty){background:rgba(52,211,153,0.07);border:1px solid rgba(52,211,153,0.25);color:#34d399}
</style>
</head><body>
<div class="layout">
  <div class="stripe"></div>
  <div class="content">
    <div class="eyebrow">PG Explorer</div>
    <h2>⚙️ Settings</h2>
    <div class="section-label">Query Defaults</div>
    <div class="f">
      <label>Default Row Limit</label>
      <input id="ql" type="number" value="${s.queryLimit}"/>
      <div class="desc">Maximum rows returned per query</div>
    </div>
    <div class="f">
      <label>Font Size</label>
      <input id="fs" type="number" value="${s.fontSize}"/>
      <div class="desc">Editor and results table font size (px)</div>
    </div>
    <button onclick="save()">Save Settings</button>
    <div id="sv"></div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
function save() { vscode.postMessage({ command: 'saveSettings', data: { queryLimit: document.getElementById('ql').value, fontSize: document.getElementById('fs').value } }); }
window.addEventListener('message', e => { if (e.data.command === 'saved') { const el = document.getElementById('sv'); el.textContent = '✅ Saved successfully'; setTimeout(() => el.textContent = '', 2500); } });
</script>
</body></html>`;
}

function openSettingsPanel(context: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel("pgExplorer.settings", "Settings", vscode.ViewColumn.One, { enableScripts: true });
  panel.webview.html = getSettingsHtml(context.globalState.get<AppSettings>("pg.settings", DEFAULT_SETTINGS));
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === "saveSettings") {
      await context.globalState.update("pg.settings", {
        queryLimit: parseInt(msg.data.queryLimit) || 100,
        fontSize: parseInt(msg.data.fontSize) || 13,
      });
      panel.webview.postMessage({ command: "saved" });
    }
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
