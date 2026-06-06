from __future__ import annotations

import json
import os
import ssl
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import httpx
from dotenv import load_dotenv
from openai import OpenAI

from backend.data.catalogue import SEED_CATALOGUE
from backend.models import RealtimeTranscriptionOfferResponse, RealtimeTranscriptionTokenResponse


load_dotenv()

REALTIME_CLIENT_SECRET_URL = "https://api.openai.com/v1/realtime/client_secrets"
REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls"


def _certificate_free_context() -> ssl.SSLContext:
    return ssl._create_unverified_context()


def _openai_urlopen(request: Request, timeout: int = 15):
    return urlopen(request, timeout=timeout, context=_certificate_free_context())


def get_openai_client() -> OpenAI | None:
    if not os.getenv("OPENAI_API_KEY"):
        return None
    return OpenAI(http_client=httpx.Client(verify=False))


def transcribe_audio_file(path: Path) -> str:
    client = get_openai_client()
    if client is None:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    with path.open("rb") as audio_file:
        transcript = client.audio.transcriptions.create(
            model=os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-transcribe"),
            file=audio_file,
        )
    return transcript.text


def _transcription_prompt() -> str:
    keywords = []
    for sku in SEED_CATALOGUE:
        keywords.append(sku.name)
        keywords.extend(sku.aliases)

    return (
        "Keywords: "
        + ", ".join(dict.fromkeys(keywords))
        + ". Preserve brand and product spellings exactly when heard."
    )


def _realtime_transcription_session_config() -> dict:
    model = os.getenv("OPENAI_REALTIME_TRANSCRIPTION_MODEL", "gpt-4o-transcribe")
    language = os.getenv("OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE")
    transcription: dict[str, str] = {"model": model}

    if language:
        transcription["language"] = language

    if model != "gpt-realtime-whisper":
        transcription["prompt"] = _transcription_prompt()

    if model == "gpt-realtime-whisper":
        delay = os.getenv("OPENAI_REALTIME_TRANSCRIPTION_DELAY", "low")
        transcription["delay"] = delay

    session: dict = {
        "type": "transcription",
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "transcription": transcription,
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.5,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 500,
                },
            }
        },
    }
    return session


def create_realtime_transcription_token() -> RealtimeTranscriptionTokenResponse:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured.")

    session = _realtime_transcription_session_config()
    body = json.dumps({"session": session}).encode("utf-8")
    request = Request(
        REALTIME_CLIENT_SECRET_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": "livecrew-local-demo",
        },
    )

    try:
        with _openai_urlopen(request, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI Realtime token request failed: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI Realtime token request failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RuntimeError("OpenAI Realtime token request timed out.") from exc

    value = data.get("value")
    if not isinstance(value, str) or not value:
        raise RuntimeError("OpenAI Realtime token response did not include a client secret.")

    session_data = data.get("session") if isinstance(data.get("session"), dict) else {}
    return RealtimeTranscriptionTokenResponse(
        value=value,
        expires_at=data.get("expires_at") if isinstance(data.get("expires_at"), int) else None,
        session_id=(
            session_data.get("id") if isinstance(session_data.get("id"), str) else None
        ),
        model=session["audio"]["input"]["transcription"]["model"],
    )


def exchange_realtime_transcription_offer(
    offer_sdp: str,
) -> RealtimeTranscriptionOfferResponse:
    if not offer_sdp.strip():
        raise RuntimeError("Realtime transcription SDP offer is required.")

    token = create_realtime_transcription_token()
    request = Request(
        REALTIME_CALLS_URL,
        data=offer_sdp.encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token.value}",
            "Content-Type": "application/sdp",
            "OpenAI-Safety-Identifier": "livecrew-local-demo",
        },
    )

    try:
        with _openai_urlopen(request, timeout=20) as response:
            answer_sdp = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI Realtime SDP exchange failed: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI Realtime SDP exchange failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise RuntimeError("OpenAI Realtime SDP exchange timed out.") from exc

    if not answer_sdp.strip():
        raise RuntimeError("OpenAI Realtime SDP exchange returned an empty answer.")

    return RealtimeTranscriptionOfferResponse(
        answer_sdp=answer_sdp,
        model=token.model,
        session_id=token.session_id,
    )
