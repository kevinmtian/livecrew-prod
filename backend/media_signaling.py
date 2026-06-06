from __future__ import annotations

from threading import Lock

from backend.models import MediaSession, create_id, utc_now


class MediaSignalStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._sessions: dict[str, MediaSession] = {}
        self._latest_session_id: str | None = None

    def create_session(self) -> MediaSession:
        with self._lock:
            session = MediaSession(session_id=create_id("media"))
            self._sessions[session.session_id] = session
            self._latest_session_id = session.session_id
            return session.model_copy(deep=True)

    def get_session(self, session_id: str) -> MediaSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            return session.model_copy(deep=True) if session else None

    def get_latest_session(self) -> MediaSession | None:
        with self._lock:
            if not self._latest_session_id:
                return None
            session = self._sessions.get(self._latest_session_id)
            return session.model_copy(deep=True) if session else None

    def set_offer(self, session_id: str, offer: dict) -> MediaSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            session.offer = offer
            session.status = "offer_ready"
            session.updated_at = utc_now()
            return session.model_copy(deep=True)

    def set_answer(self, session_id: str, answer: dict) -> MediaSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            session.answer = answer
            session.status = "answer_ready"
            session.updated_at = utc_now()
            return session.model_copy(deep=True)

    def add_candidate(self, session_id: str, role: str, candidate: dict) -> MediaSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            if role == "viewer":
                session.viewer_candidates.append(candidate)
            else:
                session.host_candidates.append(candidate)
            session.updated_at = utc_now()
            return session.model_copy(deep=True)

    def stop_session(self, session_id: str) -> MediaSession | None:
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return None
            session.status = "stopped"
            session.updated_at = utc_now()
            return session.model_copy(deep=True)


media_store = MediaSignalStore()
