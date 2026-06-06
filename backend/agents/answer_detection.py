from __future__ import annotations

import os

from pydantic import BaseModel

from backend.openai_client import get_openai_client


class ViewerQuestionAnswerAssessment(BaseModel):
    answered: bool = False


def assess_viewer_question_answered(
    question: str,
    host_transcript: str,
) -> ViewerQuestionAnswerAssessment:
    client = get_openai_client()
    if client is None:
        return ViewerQuestionAnswerAssessment(
            answered=False,
        )

    try:
        completion = client.beta.chat.completions.parse(
            model=os.getenv("OPENAI_ANSWER_DETECTION_MODEL", "gpt-4o-mini"),
            temperature=0,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Decide whether a livestream host's transcript answered a viewer question. "
                        "Return answered=true only when the host directly addresses the substance of "
                        "the question, gives a clear alternative, or explicitly says it is unavailable "
                        "and tells viewers what to do next. Do not mark answered for vague hype, generic "
                        "product talk, or unrelated speech. Be conservative."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Viewer question:\n{question}\n\n"
                        f"Host transcript:\n{host_transcript}"
                    ),
                },
            ],
            response_format=ViewerQuestionAnswerAssessment,
        )
    except Exception as exc:
        _ = exc
        return ViewerQuestionAnswerAssessment(answered=False)

    parsed = completion.choices[0].message.parsed
    if parsed is None:
        return ViewerQuestionAnswerAssessment(answered=False)
    return parsed
