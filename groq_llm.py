from __future__ import annotations

import json
from typing import Any, AsyncGenerator, Dict, List, Optional

from groq import Groq
from vanna.core.llm import LlmService, LlmRequest, LlmResponse, LlmStreamChunk
from vanna.core.tool import ToolCall, ToolSchema


class GroqLlmService(LlmService):
    """
    Groq Chat Completions-backed LLM service.

    Uses the Groq Python client with full tool-call support (RunSqlTool etc.)
    so answers come from actual database queries, not LLM hallucinations.
    """

    def __init__(
        self,
        model: Optional[str] = None,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        system_prompt: Optional[str] = None,
        **extra_client_kwargs: Any,
    ) -> None:
        self.model = model or "llama-3.1-8b-instant"
        self.system_prompt = system_prompt or ""

        print("✅ Groq model in use =", self.model)

        if api_key:
            api_key = api_key.strip()
        client_kwargs: Dict[str, Any] = {**extra_client_kwargs}
        if api_key:
            client_kwargs["api_key"] = api_key
        if base_url:
            client_kwargs["base_url"] = base_url

        self._client = Groq(**client_kwargs)

    async def send_request(self, request: LlmRequest) -> LlmResponse:
        """Send a non-streaming request to Groq and return the response.

        We bias strongly for deterministic, schema-respecting SQL by using a
        low temperature.
        """
        payload = self._build_payload(request)
        # Force low temperature for more stable SQL
        payload.setdefault("temperature", max(0.0, min(request.temperature, 0.2)))

        resp = self._client.chat.completions.create(**payload, stream=False)

        if not resp.choices:
            return LlmResponse(content=None, tool_calls=None, finish_reason=None)

        choice = resp.choices[0]
        message = choice.message
        content: Optional[str] = getattr(message, "content", None)
        tool_calls = self._extract_tool_calls_from_message(message)

        usage: Dict[str, int] = {}
        if getattr(resp, "usage", None):
            usage = {
                k: int(v)
                for k, v in {
                    "prompt_tokens": getattr(resp.usage, "prompt_tokens", 0),
                    "completion_tokens": getattr(resp.usage, "completion_tokens", 0),
                    "total_tokens": getattr(resp.usage, "total_tokens", 0),
                }.items()
            }

        return LlmResponse(
            content=content,
            tool_calls=tool_calls or None,
            finish_reason=getattr(choice, "finish_reason", None),
            usage=usage or None,
        )

    async def stream_request(
        self, request: LlmRequest
    ) -> AsyncGenerator[LlmStreamChunk, None]:
        """Stream a request to Groq, including tool calls.

        Uses low temperature to keep SQL and tool-calls consistent.
        """
        payload = self._build_payload(request)
        payload.setdefault("temperature", max(0.0, min(request.temperature, 0.2)))

        stream = self._client.chat.completions.create(**payload, stream=True)

        tc_builders: Dict[int, Dict[str, Optional[str]]] = {}
        last_finish: Optional[str] = None

        for event in stream:
            if not getattr(event, "choices", None):
                continue

            choice = event.choices[0]
            delta = getattr(choice, "delta", None)
            if delta is None:
                last_finish = getattr(choice, "finish_reason", last_finish)
                continue

            # Text
            content_piece: Optional[str] = getattr(delta, "content", None)
            if content_piece:
                yield LlmStreamChunk(content=content_piece)

            # Tool calls
            streamed_tool_calls = getattr(delta, "tool_calls", None)
            if streamed_tool_calls:
                for tc in streamed_tool_calls:
                    idx = getattr(tc, "index", 0) or 0
                    b = tc_builders.setdefault(
                        idx, {"id": None, "name": None, "arguments": ""}
                    )
                    if getattr(tc, "id", None):
                        b["id"] = tc.id
                    fn = getattr(tc, "function", None)
                    if fn is not None:
                        if getattr(fn, "name", None):
                            b["name"] = fn.name
                        if getattr(fn, "arguments", None):
                            b["arguments"] = (b["arguments"] or "") + fn.arguments

            last_finish = getattr(choice, "finish_reason", last_finish)

        # Final tool-calls chunk
        final_tool_calls: List[ToolCall] = []
        for b in tc_builders.values():
            if not b.get("name"):
                continue
            args_raw = b.get("arguments") or "{}"
            try:
                loaded = json.loads(args_raw)
                if isinstance(loaded, dict):
                    args_dict: Dict[str, Any] = loaded
                else:
                    args_dict = {"args": loaded}
            except Exception:
                args_dict = {"_raw": args_raw}
            final_tool_calls.append(
                ToolCall(
                    id=b.get("id") or "tool_call",
                    name=b["name"] or "tool",
                    arguments=args_dict,
                )
            )

        if final_tool_calls:
            yield LlmStreamChunk(tool_calls=final_tool_calls, finish_reason=last_finish)
        else:
            yield LlmStreamChunk(finish_reason=last_finish or "stop")

    async def validate_tools(self, tools: List[ToolSchema]) -> List[str]:
        """Validate tool schemas. Returns a list of error messages."""
        errors: List[str] = []
        for t in tools:
            if not t.name or len(t.name) > 64:
                errors.append(f"Invalid tool name: {t.name!r}")
        return errors

    # Internal helpers
    def _build_payload(self, request: LlmRequest) -> Dict[str, Any]:
        messages: List[Dict[str, Any]] = []

        # System prompt: prefer the one baked into the request; fall back to
        # the one stored on this service instance (set via __init__).
        system_prompt = request.system_prompt or self.system_prompt
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})

        for m in request.messages:
            msg: Dict[str, Any] = {"role": m.role, "content": m.content}
            if m.role == "tool" and m.tool_call_id:
                msg["tool_call_id"] = m.tool_call_id
            elif m.role == "assistant" and m.tool_calls:
                tool_calls_payload = []
                for tc in m.tool_calls:
                    tool_calls_payload.append(
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments),
                            },
                        }
                    )
                msg["tool_calls"] = tool_calls_payload
            messages.append(msg)

        tools_payload: Optional[List[Dict[str, Any]]] = None
        if request.tools:
            tools_payload = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in request.tools
            ]

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
        }
        if request.max_tokens is not None:
            payload["max_tokens"] = request.max_tokens
        if tools_payload:
            payload["tools"] = tools_payload

            # Determine tool_choice based on conversation state:
            # - "required": forces LLM to call a tool (before run_sql succeeds)
            # - "none":     forces LLM to write text only (after run_sql returns good data)
            # If run_sql errored, keep "required" so the LLM retries with corrected SQL.
            run_sql_succeeded = False
            for m in request.messages:
                if m.role == "tool" and m.tool_call_id:
                    name = self._tool_call_name(request.messages, m.tool_call_id)
                    if name == "run_sql":
                        content = m.content or ""
                        # If the result looks like an error, don't treat it as success
                        is_error = (
                            content.startswith("Tool failed")
                            or content.startswith("Error")
                            or "does not exist" in content
                            or "syntax error" in content
                            or "column" in content.lower() and "does not exist" in content.lower()
                        )
                        if not is_error:
                            run_sql_succeeded = True

            if run_sql_succeeded:
                payload["tool_choice"] = "none"
            else:
                payload["tool_choice"] = "required"


        return payload

    def _tool_call_name(self, messages: List[Any], tool_call_id: str) -> Optional[str]:
        """Find the tool name for a given tool_call_id by scanning assistant messages."""
        for m in messages:
            if m.role == "assistant" and m.tool_calls:
                for tc in m.tool_calls:
                    if tc.id == tool_call_id:
                        return tc.name
        return None


    def _extract_tool_calls_from_message(self, message: Any) -> List[ToolCall]:
        tool_calls: List[ToolCall] = []
        raw_tool_calls = getattr(message, "tool_calls", None) or []
        for tc in raw_tool_calls:
            fn = getattr(tc, "function", None)
            if not fn:
                continue
            args_raw = getattr(fn, "arguments", "{}")
            try:
                loaded = json.loads(args_raw)
                if isinstance(loaded, dict):
                    args_dict: Dict[str, Any] = loaded
                else:
                    args_dict = {"args": loaded}
            except Exception:
                args_dict = {"_raw": args_raw}
            tool_calls.append(
                ToolCall(
                    id=getattr(tc, "id", "tool_call"),
                    name=getattr(fn, "name", "tool"),
                    arguments=args_dict,
                )
            )
        return tool_calls