import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("prompt_model_review.py")
SPEC = importlib.util.spec_from_file_location("prompt_model_review", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "routes").mkdir()
        (self.root / "lib").mkdir()
        (self.root / "routes" / "hub-admin.js").write_text(
            "const SYSTEM_MODEL_GROUPS = [\n"
            "  { id: 'workers', label: 'Workers', slots: [\n"
            "    { feature: 'tool_worker', scope: 'system', label: 'Tool worker', note: 'Must support tool calling and structured outputs.', fallback: 'acme/tool-pro-1' },\n"
            "  ]},\n"
            "];\n",
            encoding="utf-8",
        )
        (self.root / "lib" / "prompts.js").write_text("const PROMPTS={tool_worker:'x'};\n", encoding="utf-8")
        (self.root / "lib" / "worker.js").write_text(
            "getSystemModelId('tool_worker','system','acme/tool-pro-1');\n"
            "getSystemPrompt('tool_worker','system','x');\n",
            encoding="utf-8",
        )
        self.db = self.root / "hub.db"
        con = sqlite3.connect(self.db)
        con.executescript(
            "CREATE TABLE model_config (key TEXT PRIMARY KEY,label TEXT,endpoint TEXT,model_id TEXT,tier TEXT,search TEXT,enabled INTEGER,user TEXT,category TEXT,cost_input REAL,cost_output REAL,context_length INTEGER);"
            "CREATE TABLE crm_context (id TEXT,user TEXT,key TEXT,value TEXT,UNIQUE(user,key));"
            "INSERT INTO model_config VALUES ('old','Old','openrouter','acme/tool-pro-1','everyday','none',1,NULL,'System models',1,2,64000);"
            "INSERT INTO crm_context VALUES ('1','system','hub_sys_model_tool_worker','old');"
            "INSERT INTO crm_context VALUES ('2','system','hub_sys_prompt_tool_worker','custom prompt');"
        )
        con.commit()
        con.close()
        self.catalog = [
            {
                "id": "acme/tool-pro-1", "name": "Old", "expiration_date": "2026-01-01",
                "context_length": 64000, "architecture": {"input_modalities": ["text"], "output_modalities": ["text"], "tokenizer": "Acme", "instruct_type": "chatml"},
                "supported_parameters": ["tools", "structured_outputs"], "pricing": {"prompt": "0.000001", "completion": "0.000002"},
            },
            {
                "id": "cheap/basic", "name": "Cheap but incompatible", "expiration_date": None,
                "context_length": 128000, "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                "supported_parameters": ["temperature"], "pricing": {"prompt": "0.0000001", "completion": "0.0000001"},
            },
            {
                "id": "acme/tool-pro-2", "name": "Tool Pro 2", "expiration_date": None,
                "context_length": 128000, "architecture": {"input_modalities": ["text"], "output_modalities": ["text"], "tokenizer": "Acme", "instruct_type": "chatml"},
                "supported_parameters": ["tools", "structured_outputs", "response_format"], "pricing": {"prompt": "0.0000012", "completion": "0.0000022"},
            },
        ]

    def tearDown(self):
        self.temp.cleanup()

    def test_deprecated_capability_preserving_replacement(self):
        report = MODULE.review(self.root, self.db, self.catalog, "fixture", date(2026, 7, 18), {"slots": {}})
        issue = next(row for row in report["issues"] if row["code"] == "deprecated")
        self.assertEqual(issue["recommendations"][0]["id"], "acme/tool-pro-2")
        self.assertNotIn("cheap/basic", [row["id"] for row in issue["recommendations"]])

    def test_safe_install_is_disabled_and_idempotent(self):
        report = MODULE.review(self.root, self.db, self.catalog, "fixture", date(2026, 7, 18), {"slots": {}})
        issue = next(row for row in report["issues"] if row["code"] == "deprecated")
        first = MODULE.safe_auto_install(report, issue["id"], self.db, self.root, 0.72)
        second = MODULE.safe_auto_install(report, issue["id"], self.db, self.root, 0.72)
        self.assertEqual(first["result"]["action"], "inserted_disabled")
        self.assertEqual(second["result"]["action"], "already_present")
        con = sqlite3.connect(self.db)
        row = con.execute("SELECT enabled FROM model_config WHERE model_id='acme/tool-pro-2'").fetchone()
        context = con.execute("SELECT key,value FROM crm_context ORDER BY key").fetchall()
        con.close()
        self.assertEqual(row[0], 0)
        self.assertEqual(context, [
            ("hub_sys_model_tool_worker", "old"),
            ("hub_sys_prompt_tool_worker", "custom prompt"),
        ])

    def test_malformed_catalogue_fails_closed(self):
        path = self.root / "bad.json"
        path.write_text(json.dumps({"data": []}), encoding="utf-8")
        with self.assertRaises(MODULE.ReviewError):
            MODULE.load_catalog(path, "unused")

    def test_version_punctuation_and_canonical_order_resolve(self):
        direct, suffixes = MODULE.model_lookup([
            {
                "id": "anthropic/claude-haiku-4.5",
                "canonical_slug": "anthropic/claude-4.5-haiku-20251001",
            }
        ])
        self.assertEqual(
            MODULE.resolve_model("anthropic/claude-haiku-4-5", direct, suffixes)["id"],
            "anthropic/claude-haiku-4.5",
        )
        self.assertEqual(
            MODULE.resolve_model("anthropic/claude-haiku-4-5-20251001", direct, suffixes)["id"],
            "anthropic/claude-haiku-4.5",
        )

    def test_display_fallback_resolves_env_alternative_and_model_key(self):
        models = {"free": {"model_id": "openrouter/free"}}
        self.assertEqual(
            MODULE.effective_fallback_id("DIGEST_MODEL env or google/gemini-2.5-pro-preview", models),
            ("google/gemini-2.5-pro-preview", "fallback"),
        )
        self.assertEqual(
            MODULE.effective_fallback_id("free (or WORKDAY_NARRATIVE_MODEL env)", models),
            ("openrouter/free", "fallback-key"),
        )


if __name__ == "__main__":
    unittest.main()
