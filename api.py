import os
import re
import json as _json
from dotenv import load_dotenv, find_dotenv

dotenv_path = find_dotenv()
load_dotenv(dotenv_path)

from vanna import Agent
from vanna.core.registry import ToolRegistry
from vanna.core.user import UserResolver, User, RequestContext
from vanna.tools import RunSqlTool
from vanna.core.system_prompt import DefaultSystemPromptBuilder
from vanna.integrations.local.agent_memory import DemoAgentMemory
from vanna.integrations.postgres import PostgresRunner

try:
    from vanna.integrations.mysql import MySQLRunner
    _MYSQL_AVAILABLE = True
except ImportError:
    _MYSQL_AVAILABLE = False
    print("⚠️  MySQLRunner not available — install vanna[mysql]")

try:
    from vanna.integrations.oracle import OracleRunner
    _ORACLE_AVAILABLE = True
except ImportError:
    _ORACLE_AVAILABLE = False
    print("⚠️  OracleRunner not available — install vanna[oracle]")


# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

_MANDATORY_RULES = """

=== CRITICAL MANDATORY RULES ===

1. You MUST call the `run_sql` tool for every data question. No exceptions.
   Do NOT write SQL as plain text. Do NOT output <function=...> tags manually.
   Simply call the tool directly.

2. Use ONLY the exact table and column names listed in the schema above.

3. After run_sql returns results, write ONE short summary sentence.
   Do NOT repeat the raw data in text.

4. If run_sql returns an error, fix the SQL and retry immediately.

=== END RULES ===
"""

# ── These JOIN correction rules are APPENDED after schema.txt so they always
#    override any incomplete/wrong JOIN examples the user may have in schema.txt
_POSTGRES_JOIN_CORRECTIONS = """

=== POSTGRESQL JOIN CORRECTION RULES — READ CAREFULLY ===

The artist table has ONLY these columns: artist_id, name
The album  table has ONLY these columns: album_id, title, artist_id
The track  table has ONLY these columns: track_id, name, album_id, genre_id, milliseconds, unit_price

NEVER do: artist.track_id  — this column does NOT exist
NEVER do: album.track_id   — this column does NOT exist
NEVER do: ORDER BY COUNT(track_id) without a JOIN to track

To count tracks per artist you MUST join through album:
  FROM artist ar
  JOIN album al ON ar.artist_id = al.artist_id
  JOIN track t  ON al.album_id  = t.album_id

CORRECT EXAMPLES — memorise these exactly:

-- Top 5 artists by track count
SELECT ar.name, COUNT(t.track_id) AS track_count
FROM artist ar
JOIN album al ON ar.artist_id = al.artist_id
JOIN track t  ON al.album_id  = t.album_id
GROUP BY ar.name
ORDER BY track_count DESC
LIMIT 5;

-- Top 5 artists by total revenue
SELECT ar.name, ROUND(SUM(il.unit_price * il.quantity)::numeric, 2) AS total_sales
FROM artist ar
JOIN album        al ON ar.artist_id  = al.artist_id
JOIN track        t  ON al.album_id   = t.album_id
JOIN invoice_line il ON t.track_id    = il.track_id
GROUP BY ar.name
ORDER BY total_sales DESC
LIMIT 5;

-- Tracks in a genre
SELECT t.name, ar.name AS artist
FROM track t
JOIN album  al ON t.album_id   = al.album_id
JOIN artist ar ON al.artist_id = ar.artist_id
JOIN genre  g  ON t.genre_id   = g.genre_id
WHERE g.name = 'Rock'
LIMIT 10;

=== END POSTGRESQL JOIN CORRECTION RULES ===
"""

_MYSQL_SCHEMA = """
You are a MySQL expert connected to a sales database.
The database name is already selected — do NOT prefix table names.

SCHEMA:

productlines : productLine (PK), textDescription, htmlDescription, image
products     : productCode (PK), productName, productLine (FK->productlines),
               productScale, productVendor, productDescription,
               quantityInStock, buyPrice, MSRP
offices      : officeCode (PK), city, phone, addressLine1, addressLine2,
               state, country, postalCode, territory
employees    : employeeNumber (PK), lastName, firstName, extension, email,
               officeCode (FK->offices), reportsTo (FK->employees), jobTitle
customers    : customerNumber (PK), customerName, contactLastName,
               contactFirstName, phone, addressLine1, addressLine2,
               city, state, postalCode, country,
               salesRepEmployeeNumber (FK->employees), creditLimit
payments     : customerNumber (PK/FK->customers), checkNumber (PK),
               paymentDate, amount
orders       : orderNumber (PK), orderDate, requiredDate, shippedDate,
               status, comments, customerNumber (FK->customers)
orderdetails : orderNumber (PK/FK->orders), productCode (PK/FK->products),
               quantityOrdered, priceEach, orderLineNumber

JOIN paths:
  orders->customers  : JOIN customers ON orders.customerNumber=customers.customerNumber
  orders->products   : JOIN orderdetails ON orders.orderNumber=orderdetails.orderNumber
                       JOIN products ON orderdetails.productCode=products.productCode
  products->lines    : JOIN productlines ON products.productLine=productlines.productLine
  employees->offices : JOIN offices ON employees.officeCode=offices.officeCode
  payments->customers: JOIN customers ON payments.customerNumber=customers.customerNumber

EXAMPLE — top 5 orders by value:
  SELECT o.orderNumber, c.customerName,
         SUM(od.quantityOrdered * od.priceEach) AS order_value
  FROM orders o
  JOIN customers c ON o.customerNumber = c.customerNumber
  JOIN orderdetails od ON o.orderNumber = od.orderNumber
  GROUP BY o.orderNumber, c.customerName
  ORDER BY order_value DESC LIMIT 5;
"""

_ORACLE_SCHEMA = """
You are an Oracle SQL expert.
SCHEMA: (add your Oracle tables here)
"""


def _build_system_prompt(db_type: str) -> str:
    if db_type == "mysql":
        return _MYSQL_SCHEMA + _MANDATORY_RULES

    elif db_type == "oracle":
        return _ORACLE_SCHEMA + _MANDATORY_RULES

    else:
        # PostgreSQL — load schema.txt then ALWAYS append the JOIN correction rules
        # This guarantees the LLM never generates wrong artist->track SQL
        schema_path = os.path.join(os.path.dirname(__file__), "schema.txt")
        base = ""
        if os.path.exists(schema_path):
            with open(schema_path, "r", encoding="utf-8") as f:
                base = f.read()
            print("✅ schema.txt loaded")
        else:
            print("⚠️  schema.txt not found — using built-in schema")

        # Append JOIN corrections AFTER schema.txt so they take precedence
        return base + _POSTGRES_JOIN_CORRECTIONS + _MANDATORY_RULES


# ─────────────────────────────────────────────────────────────────────────────
# LLM FACTORY
# ─────────────────────────────────────────────────────────────────────────────

def _clean_api_key(raw: str) -> str:
    val = (raw or "").strip().strip('"').strip("'")
    if "=" in val:
        val = val.split("=", 1)[-1].strip()
    return val

_raw_provider = os.getenv("LLM_PROVIDER", "").strip().lower()
_groq_key     = _clean_api_key(os.getenv("GROQ_API_KEY",   ""))
_google_key   = _clean_api_key(os.getenv("GOOGLE_API_KEY", "") or os.getenv("GEMINI_API_KEY", ""))

def _is_valid_key(k: str) -> bool:
    if not k: return False
    bad = {"your_google_api_key_here","your_gemini_api_key_here",
           "your_groq_api_key_here","your_api_key","placeholder","your_key_here",""}
    return k.lower() not in bad and not k.startswith("your_")

_groq_valid   = _is_valid_key(_groq_key)
_google_valid = _is_valid_key(_google_key)

print(f"[ENV] LLM_PROVIDER='{_raw_provider}' | groq_valid={_groq_valid} | google_valid={_google_valid}")

# Determine env-level provider (used as fallback when no per-request config)
_env_provider: str
if _raw_provider == "groq" and _groq_valid:
    _env_provider = "groq"
elif _raw_provider in ("gemini", "google") and _google_valid:
    _env_provider = "gemini"
elif _groq_valid:
    _env_provider = "groq"
    print("⚠️  Falling back to Groq (GROQ_API_KEY is valid)")
elif _google_valid:
    _env_provider = "gemini"
    print("⚠️  Falling back to Gemini (GOOGLE_API_KEY is valid)")
else:
    _env_provider = ""  # No env key — must come from per-request config
    print("⚠️  No valid LLM key in .env — must be provided per-request via config")


def _make_llm(system_prompt: str, cfg=None):
    """Create an LLM instance. cfg (ConnectionConfig) fields take priority over env vars."""
    # Resolve API key and provider from per-request config, fall back to env
    req_provider = (getattr(cfg, "llm_provider", None) or "").strip().lower()
    req_groq_key = _clean_api_key(getattr(cfg, "groq_api_key", None) or "")
    req_google_key = _clean_api_key(getattr(cfg, "google_api_key", None) or "")
    req_groq_model = getattr(cfg, "groq_model", None) or os.getenv("GROQ_MODEL")
    req_google_model = getattr(cfg, "google_model", None) or os.getenv("GOOGLE_MODEL")

    # Determine which provider + key to use
    groq_key = req_groq_key if _is_valid_key(req_groq_key) else _groq_key
    google_key = req_google_key if _is_valid_key(req_google_key) else _google_key
    groq_valid = _is_valid_key(groq_key)
    google_valid = _is_valid_key(google_key)

    if req_provider == "groq" and groq_valid:
        provider = "groq"
    elif req_provider in ("gemini", "google") and google_valid:
        provider = "gemini"
    elif _env_provider:
        provider = _env_provider
    elif groq_valid:
        provider = "groq"
    elif google_valid:
        provider = "gemini"
    else:
        raise ValueError(
            "No valid LLM API key found. "
            "Set llm_provider + groq_api_key / google_api_key in the connection config."
        )

    if provider == "gemini":
        from gemini_llm import GeminiLlmService
        return GeminiLlmService(
            api_key=google_key,
            model=req_google_model,
            system_prompt=system_prompt,
        )
    else:
        from groq_llm import GroqLlmService
        return GroqLlmService(
            api_key=groq_key,
            model=req_groq_model,
        )


# ─────────────────────────────────────────────────────────────────────────────
# DATABASE RUNNERS
# ─────────────────────────────────────────────────────────────────────────────

def _make_postgres_runner(cfg=None) -> PostgresRunner:
    """Create a Postgres runner. cfg fields override env vars."""
    host     = (getattr(cfg, "db_host",     None) or os.getenv("DB_HOST"))
    port     = (getattr(cfg, "db_port",     None) or int(os.getenv("DB_PORT", "5432")))
    database = (getattr(cfg, "db_name",     None) or os.getenv("DB_NAME"))
    user     = (getattr(cfg, "db_user",     None) or os.getenv("DB_USER"))
    password = (getattr(cfg, "db_password", None) or os.getenv("DB_PASSWORD", ""))
    return PostgresRunner(host=host, port=int(port), database=database, user=user, password=password)


def _make_mysql_runner(cfg=None):
    if not _MYSQL_AVAILABLE:
        raise RuntimeError("MySQL not installed. Run: pip install vanna[mysql]")

    host     = (getattr(cfg, "mysql_host",     None) or os.getenv("MYSQL_HOST", "localhost"))
    port     = int(getattr(cfg, "mysql_port",  None) or os.getenv("MYSQL_PORT", "3306"))
    database = (getattr(cfg, "mysql_db",       None) or
                os.getenv("MYSQL_DB") or os.getenv("MYSQL_DATABASE") or os.getenv("MYSQL_SCHEMA"))
    user     = (getattr(cfg, "mysql_user",     None) or os.getenv("MYSQL_USER"))
    password = (getattr(cfg, "mysql_password", None) or os.getenv("MYSQL_PASSWORD", ""))

    if not database:
        raise RuntimeError(
            "MySQL database name is not set. "
            "Set it in the connection config or in MYSQL_DB env var."
        )

    print(f"  [MySQL] connecting to {host}:{port}/{database} as {user}")
    runner   = None
    last_err = None

    for kwargs in [
        dict(host=host, port=port, database=database, user=user, password=password),
        dict(host=host, port=port, db=database,       user=user, password=password),
        dict(host=host, port=port, schema=database,   user=user, password=password),
    ]:
        try:
            runner = MySQLRunner(**kwargs)
            print(f"  [MySQL] runner created with {list(kwargs.keys())}")
            break
        except TypeError as e:
            last_err = e

    if runner is None:
        try:
            runner = MySQLRunner(host, user, password, database)
            print("  [MySQL] runner created positionally")
        except Exception as e:
            last_err = e

    if runner is None:
        raise RuntimeError(f"Could not create MySQLRunner: {last_err}")

    return runner


def _make_oracle_runner(cfg=None):
    if not _ORACLE_AVAILABLE:
        raise RuntimeError("Oracle not installed. Run: pip install vanna[oracle]")
    host     = (getattr(cfg, "oracle_host",    None) or os.getenv("ORACLE_HOST", "localhost"))
    port     = int(getattr(cfg, "oracle_port", None) or os.getenv("ORACLE_PORT", "1521"))
    service  = (getattr(cfg, "oracle_service", None) or os.getenv("ORACLE_SERVICE"))
    user     = (getattr(cfg, "oracle_user",    None) or os.getenv("ORACLE_USER"))
    password = (getattr(cfg, "oracle_password",None) or os.getenv("ORACLE_PASSWORD"))
    return OracleRunner(host=host, port=port, service_name=service, user=user, password=password)


RUNNER_FACTORY: dict[str, callable] = {
    "postgres": _make_postgres_runner,
    "mysql":    _make_mysql_runner,
    "oracle":   _make_oracle_runner,
}

# NOTE: agent_memory is intentionally created fresh inside build_agent()
# so each request starts with a clean slate and never sees previous query history.


class SimpleUserResolver(UserResolver):
    async def resolve_user(self, request_context: RequestContext) -> User:
        return User(id="local-user", email="local@example.com", group_memberships=["admin"])


def build_agent(db_type: str, sql_runner=None, cfg=None) -> Agent:
    if sql_runner is None:
        factory = RUNNER_FACTORY.get(db_type, _make_postgres_runner)
        try:
            sql_runner = factory(cfg)
        except (ImportError, RuntimeError) as e:
            raise RuntimeError(str(e)) from e

    db_tool = RunSqlTool(sql_runner=sql_runner)
    tools   = ToolRegistry()
    tools.register_local_tool(db_tool, access_groups=["admin"])

    system_prompt = _build_system_prompt(db_type)
    llm = _make_llm(system_prompt, cfg)
    print(f"  [Agent] db_type={db_type}, prompt_chars={len(system_prompt)}")

    # Fresh memory per request — prevents previous query answers from leaking in
    fresh_memory = DemoAgentMemory(max_items=1000)

    return Agent(
        llm_service=llm,
        tool_registry=tools,
        user_resolver=SimpleUserResolver(),
        agent_memory=fresh_memory,
        system_prompt_builder=DefaultSystemPromptBuilder(base_prompt=system_prompt),
    )


# ─────────────────────────────────────────────────────────────────────────────
# TOOL-CALL LEAK HANDLER
# ─────────────────────────────────────────────────────────────────────────────

_LEAK_EXTRACT_PATTERNS = [
    re.compile(r"<function=run_sql>\s*(\{.*?\})\s*</function>", re.DOTALL),
    re.compile(r"```run_sql\s*(\{.*?\})\s*```",                 re.DOTALL),
    re.compile(r"\[run_sql\((\{.*?\})\)\]",                     re.DOTALL),
]
_LEAK_STRIP_PATTERNS = [
    re.compile(r"<function=\w+>\s*\{.*?\}\s*</function>", re.DOTALL),
    re.compile(r"```\w+\s*\{.*?\}\s*```",                 re.DOTALL),
    re.compile(r"\[\w+\(\{.*?\}\)\]",                     re.DOTALL),
]


def _extract_sql_from_leak(text: str):
    for pattern in _LEAK_EXTRACT_PATTERNS:
        m = pattern.search(text)
        if m:
            try:
                payload = _json.loads(m.group(1))
                sql = payload.get("sql") or payload.get("query") or ""
                if sql.strip(): return sql.strip()
            except Exception:
                pass
    return None


def _strip_tool_leak(text: str) -> str:
    cleaned = text
    for pattern in _LEAK_STRIP_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def _execute_leaked_sql(sql: str, sql_runner, db_type: str = "postgres"):
    print(f"  [LeakRecovery] executing ({db_type}): {sql[:100]}...")

    def _records_to_output(records):
        if not records:
            return {"type": "data", "content": {"columns": [], "rows": []}}
        cols = list(records[0].keys())
        rows = [[row.get(c) for c in cols] for row in records]
        print(f"  [LeakRecovery] SUCCESS — {len(rows)} rows")
        return {"type": "data", "content": {"columns": cols, "rows": rows}}

    def _df_to_output(df):
        if df is None: return None
        if hasattr(df, "empty") and df.empty:
            return {"type": "data", "content": {"columns": [], "rows": []}}
        records = df.to_dict(orient="records") if hasattr(df, "to_dict") else (df if isinstance(df, list) else None)
        return _records_to_output(records) if records is not None else None

    try:
        result = _df_to_output(sql_runner.run_sql(sql))
        if result: return result
    except Exception as e:
        print(f"  [LeakRecovery] runner.run_sql(sql) failed: {e}")

    try:
        result = _df_to_output(sql_runner.run_sql(sql=sql))
        if result: return result
    except Exception as e:
        print(f"  [LeakRecovery] runner.run_sql(sql=sql) failed: {e}")

    if db_type == "mysql":
        host     = os.getenv("MYSQL_HOST", "localhost")
        port     = int(os.getenv("MYSQL_PORT", "3306"))
        database = os.getenv("MYSQL_DB") or os.getenv("MYSQL_DATABASE") or ""
        user     = os.getenv("MYSQL_USER", "")
        password = os.getenv("MYSQL_PASSWORD", "")
        try:
            import pymysql, pymysql.cursors
            conn = pymysql.connect(host=host, port=port, user=user, password=password,
                                   database=database, cursorclass=pymysql.cursors.DictCursor,
                                   connect_timeout=5)
            with conn:
                with conn.cursor() as cur:
                    cur.execute(sql)
                    return _records_to_output(cur.fetchall())
        except Exception as e:
            print(f"  [LeakRecovery] pymysql failed: {e}")

    print("  [LeakRecovery] all strategies exhausted")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# UICOMPONENT EXTRACTOR
# ─────────────────────────────────────────────────────────────────────────────

_UI_ONLY_TYPES = {
    "status_bar_update","task_tracker_update","chat_input_update",
    "status_bar_create","status_bar_delete","task_tracker_create",
    "task_tracker_delete","loading","progress","spinner",
    "lifecycle_update","ui_update",
}


def _try_rich(rich: dict) -> dict | None:
    if not isinstance(rich, dict): return None
    rich_type = (rich.get("type") or "").lower()
    if rich_type in _UI_ONLY_TYPES: return None

    if rich_type in ("dataframe", "table", "df"):
        cols     = rich.get("columns") or rich.get("cols") or []
        rows_raw = rich.get("rows")    or rich.get("data") or []
        if cols and rows_raw:
            rows = [[r.get(c) for c in cols] for r in rows_raw] if isinstance(rows_raw[0], dict) else rows_raw
            return {"type": "data", "content": {"columns": cols, "rows": rows}}
        if cols:
            return {"type": "data", "content": {"columns": cols, "rows": []}}

    elif rich_type in ("text", "markdown", "message"):
        txt = rich.get("content") or rich.get("text") or rich.get("message") or ""
        if isinstance(txt, str) and txt.strip():
            return {"type": "text", "content": _strip_tool_leak(txt)}

    elif rich_type == "status_card":
        sql_val = (rich.get("metadata") or {}).get("sql", "")
        if sql_val: return {"type": "sql", "content": sql_val.strip()}

    # Generic fallback
    cols     = rich.get("columns") or rich.get("cols") or []
    rows_raw = rich.get("rows")    or rich.get("data") or []
    if cols and rows_raw:
        rows = [[r.get(c) for c in cols] for r in rows_raw] if isinstance(rows_raw[0], dict) else rows_raw
        return {"type": "data", "content": {"columns": cols, "rows": rows}}
    for key in ("content", "text", "message", "summary"):
        val = rich.get(key)
        if isinstance(val, str) and val.strip():
            cleaned = _strip_tool_leak(val)
            if cleaned: return {"type": "text", "content": cleaned}
    return None


def _extract_uicomponent(raw: dict, debug: bool = False) -> dict | None:
    if debug:
        print(f"[DEBUG UiComponent]:\n{_json.dumps(raw, default=str, indent=2)[:1000]}")

    # Shape A: rich_component at top level (Vanna >= 0.8)
    rich_top = raw.get("rich_component")
    if isinstance(rich_top, dict):
        result = _try_rich(rich_top)
        if result: return result

    # Shape B: simple_component
    simple = raw.get("simple_component")
    if isinstance(simple, dict):
        result = _try_rich(simple)
        if result: return result
        for key in ("text", "message", "content"):
            val = simple.get(key)
            if isinstance(val, str) and val.strip():
                leaked = _extract_sql_from_leak(val)
                if leaked: return {"type": "sql_leak", "content": leaked}
                cleaned = _strip_tool_leak(val)
                if cleaned: return {"type": "text", "content": cleaned}
    elif isinstance(simple, str) and simple.strip():
        leaked = _extract_sql_from_leak(simple)
        if leaked: return {"type": "sql_leak", "content": leaked}
        cleaned = _strip_tool_leak(simple)
        if cleaned: return {"type": "text", "content": cleaned}

    # Shape C: content wrapper (older Vanna)
    content = raw.get("content")
    if isinstance(content, dict):
        for rkey in ("rich_component", "richComponent", "component"):
            rich = content.get(rkey)
            if isinstance(rich, dict):
                result = _try_rich(rich)
                if result: return result
        result = _try_rich(content)
        if result: return result
        for key in ("text", "message", "summary", "content"):
            val = content.get(key)
            if isinstance(val, str) and val.strip():
                cleaned = _strip_tool_leak(val)
                if cleaned: return {"type": "text", "content": cleaned}

    # Shape D: raw itself has data
    result = _try_rich(raw)
    if result: return result
    for key in ("text", "message", "summary"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            cleaned = _strip_tool_leak(val)
            if cleaned: return {"type": "text", "content": cleaned}
    return None


# ─────────────────────────────────────────────────────────────────────────────
# FASTAPI
# ─────────────────────────────────────────────────────────────────────────────

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Literal, Optional
import uvicorn

app = FastAPI(title="Vanna API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


class ConnectionConfig(BaseModel):
    """Per-request LLM + DB config. If provided, overrides env vars."""
    # LLM
    llm_provider: Optional[str] = None   # "groq" or "gemini"
    groq_api_key: Optional[str] = None
    groq_model: Optional[str] = None
    google_api_key: Optional[str] = None
    google_model: Optional[str] = None
    # PostgreSQL
    db_host: Optional[str] = None
    db_port: Optional[int] = 5432
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    db_password: Optional[str] = None
    # MySQL
    mysql_host: Optional[str] = None
    mysql_port: Optional[int] = 3306
    mysql_db: Optional[str] = None
    mysql_user: Optional[str] = None
    mysql_password: Optional[str] = None
    # Oracle
    oracle_host: Optional[str] = None
    oracle_port: Optional[int] = 1521
    oracle_service: Optional[str] = None
    oracle_user: Optional[str] = None
    oracle_password: Optional[str] = None


class QueryRequest(BaseModel):
    query: str
    db_type: Optional[Literal["postgres", "mysql", "oracle"]] = "postgres"
    config: Optional[ConnectionConfig] = None


class TestConnectionRequest(BaseModel):
    db_type: Optional[Literal["postgres", "mysql", "oracle"]] = "postgres"
    config: Optional[ConnectionConfig] = None


_debug_printed = False


@app.post("/api/ask")
async def ask_database(request: QueryRequest):
    global _debug_printed
    _debug_printed = False

    db_type = request.db_type or "postgres"
    cfg     = request.config  # May be None — falls back to env vars
    print(f"--- Query [{db_type.upper()}]: {request.query} (config={'yes' if cfg else 'env'}) ---")

    try:
        runner_factory = RUNNER_FACTORY.get(db_type, _make_postgres_runner)
        sql_runner = runner_factory(cfg)
        agent      = build_agent(db_type, sql_runner=sql_runner, cfg=cfg)
        context    = RequestContext(headers={}, query_params={})
        output     = []

        async for component in agent.send_message(request_context=context, message=request.query):
            comp_type = component.__class__.__name__
            print(f"Found component: {comp_type}")

            # ── Text ──────────────────────────────────────────────────────
            if comp_type == "Text":
                raw_text   = component.text or ""
                leaked_sql = _extract_sql_from_leak(raw_text)
                if leaked_sql:
                    print("  [LeakDetected] recovering SQL from Text...")
                    data_item = _execute_leaked_sql(leaked_sql, sql_runner, db_type=db_type)
                    if data_item:
                        output.append({"type": "sql",  "content": leaked_sql})
                        output.append(data_item)
                    else:
                        cleaned = _strip_tool_leak(raw_text)
                        if cleaned: output.append({"type": "text", "content": cleaned})
                else:
                    cleaned = _strip_tool_leak(raw_text)
                    skip = ["issue with the user account","correct credentials",
                            "necessary permissions","let me try again","cannot use function calls"]
                    if cleaned and not any(p in cleaned.lower() for p in skip):
                        output.append({"type": "text", "content": cleaned})

            # ── SQL ───────────────────────────────────────────────────────
            elif comp_type == "Sql":
                output.append({"type": "sql", "content": component.sql})

            # ── DataFrame ────────────────────────────────────────────────
            elif comp_type in ["DataFrame", "Table"] or hasattr(component, "df"):
                df_data = component.df.to_dict(orient="records")
                if df_data:
                    cols = list(df_data[0].keys())
                    rows = [[row.get(c) for c in cols] for row in df_data]
                    output.append({"type": "data", "content": {"columns": cols, "rows": rows}})
                else:
                    output.append({"type": "data", "content": {"columns": [], "rows": []}})

            # ── UiComponent ───────────────────────────────────────────────
            elif comp_type == "UiComponent":
                try:
                    raw = component.model_dump() if hasattr(component, "model_dump") else component.dict()
                    should_debug = not _debug_printed
                    if should_debug: _debug_printed = True
                    extracted = _extract_uicomponent(raw, debug=should_debug)
                    if extracted:
                        print(f"  -> extracted type={extracted['type']}")
                        if extracted["type"] == "sql_leak":
                            leaked_sql = extracted["content"]
                            output.append({"type": "sql", "content": leaked_sql})
                            data_item = _execute_leaked_sql(leaked_sql, sql_runner, db_type=db_type)
                            if data_item: output.append(data_item)
                        else:
                            output.append(extracted)
                    else:
                        rich  = raw.get("rich_component", {})
                        rtype = (rich.get("type") or "") if isinstance(rich, dict) else ""
                        print(f"  -> skipped ({rtype or 'no rich_component'})")
                except Exception as parse_err:
                    print(f"UiComponent parse error: {parse_err}")
                    import traceback; traceback.print_exc()

            # ── Chart ─────────────────────────────────────────────────────
            elif comp_type == "Plotly":
                chart_data = component.model_dump() if hasattr(component, "model_dump") else component.dict()
                output.append({"type": "chart", "content": chart_data})

            # ── Fallback ──────────────────────────────────────────────────
            else:
                try:
                    dumped = component.model_dump() if hasattr(component, "model_dump") else component.dict()
                    output.append({"type": comp_type.lower(), "content": dumped})
                except Exception:
                    output.append({"type": comp_type.lower(), "content": str(component)})

        print(f"  -> output items: {len(output)}, types: {[i['type'] for i in output]}")
        return {"status": "success", "query": request.query, "db_type": db_type, "response": output}

    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        import traceback
        print(f"CRITICAL ERROR: {str(e)}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health():
    return {"status": "Vanna API is running locally!"}


@app.post("/api/test-connection")
async def test_connection(request: TestConnectionRequest):
    """Validate DB credentials + LLM key from the form before saving a connection."""
    db_type = request.db_type or "postgres"
    cfg     = request.config
    errors  = []

    # ── Test DB connection ──────────────────────────────────────────────────
    try:
        runner_factory = RUNNER_FACTORY.get(db_type, _make_postgres_runner)
        runner = runner_factory(cfg)
        # Run a trivial query to confirm connectivity
        if db_type == "postgres":
            import psycopg2
            host     = (getattr(cfg, "db_host",     None) or os.getenv("DB_HOST"))
            port     = int(getattr(cfg, "db_port",  None) or os.getenv("DB_PORT", 5432))
            database = (getattr(cfg, "db_name",     None) or os.getenv("DB_NAME"))
            user     = (getattr(cfg, "db_user",     None) or os.getenv("DB_USER"))
            password = (getattr(cfg, "db_password", None) or os.getenv("DB_PASSWORD", ""))
            conn = psycopg2.connect(host=host, port=port, dbname=database,
                                    user=user, password=password, connect_timeout=5)
            conn.close()
    except Exception as e:
        errors.append(f"Database: {e}")

    # ── Test LLM key ────────────────────────────────────────────────────────
    try:
        req_provider = (getattr(cfg, "llm_provider", None) or "").strip().lower()
        req_groq_key = _clean_api_key(getattr(cfg, "groq_api_key", None) or "")
        req_google_key = _clean_api_key(getattr(cfg, "google_api_key", None) or "")

        groq_key   = req_groq_key   if _is_valid_key(req_groq_key)   else _groq_key
        google_key = req_google_key if _is_valid_key(req_google_key) else _google_key

        if req_provider == "groq" or (not req_provider and _is_valid_key(groq_key)):
            if not _is_valid_key(groq_key):
                errors.append("LLM: Groq API key is missing or invalid")
        elif req_provider in ("gemini", "google") or (not req_provider and _is_valid_key(google_key)):
            if not _is_valid_key(google_key):
                errors.append("LLM: Google/Gemini API key is missing or invalid")
        else:
            errors.append("LLM: No valid API key provided (set groq_api_key or google_api_key)")
    except Exception as e:
        errors.append(f"LLM key check: {e}")

    if errors:
        raise HTTPException(status_code=400, detail=" | ".join(errors))

    return {"status": "ok", "message": f"Connected to {db_type} successfully"}


if __name__ == "__main__":
    print("🚀 API Running at http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
