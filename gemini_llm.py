from google import genai
from typing import AsyncIterator, List, Optional


# ------------------------------------------------------------------
# EXACT structure Vanna expects
# ------------------------------------------------------------------
class LlmChunk:
    def __init__(
        self,
        content: str = "",
        tool_calls: Optional[List] = None,
        finish_reason: Optional[str] = None,
    ):
        self.content = content
        self.tool_calls = tool_calls or []
        self.finish_reason = finish_reason


class GeminiLlmService:
    def __init__(self, api_key: str, model: str, system_prompt: str = ""):
        if not api_key:
            raise ValueError("GOOGLE_API_KEY is not set")

        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.system_prompt = system_prompt or ""

    # ------------------------------------------------------------------
    # ASYNC ITERATOR returning LlmChunk objects
    # ------------------------------------------------------------------
    async def stream_request(self, request) -> AsyncIterator[LlmChunk]:
        try:
            prompt = self._build_prompt(request)

            response = self.client.models.generate_content(
                model=self.model,
                contents=prompt
            )

            text = response.text or ""

            # 1️⃣ main content chunk
            yield LlmChunk(content=text)

            # 2️⃣ end-of-stream marker (VERY IMPORTANT)
            yield LlmChunk(finish_reason="stop")

        except Exception as e:
            print("❌ Gemini error:", str(e))
            yield LlmChunk(
                content="ERROR: Gemini request failed. Falling back.",
                finish_reason="error"
            )

    # ------------------------------------------------------------------
    # Vanna messages are tuples, not dicts
    # ------------------------------------------------------------------
    def _build_prompt(self, request) -> str:
        parts = []

        if self.system_prompt:
            parts.append("SYSTEM:\n" + self.system_prompt.strip())

        for msg in request.messages:
            if isinstance(msg, tuple) and len(msg) >= 2:
                role, content = msg[0], msg[1]
                parts.append(f"{str(role).upper()}:\n{content}")
            else:
                parts.append(str(msg))

        parts.append("ASSISTANT:")
        return "\n\n".join(parts)